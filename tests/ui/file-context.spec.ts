import { test, expect, type Page } from '@playwright/test';
import {
  concurrentFixture,
  connectClaude,
  installClaudeFixture,
  mockDesktop,
  openProject,
  switchTask,
} from './fixtures';

const ROOT = '/fixture/project';
const snapshotLabel = (path = 'hello.txt') => `${path} · editor snapshot`;
const contextButton = (page: Page) =>
  page.getByRole('button', { name: 'Add file context for current editor' });
const picker = (page: Page) =>
  page.getByRole('dialog', { name: 'Add file context', exact: true });
const preview = (page: Page) =>
  page.getByRole('dialog', { name: 'Context preview' });
const prompt = (page: Page) =>
  page.getByRole('textbox', { name: 'Task prompt' });
const chip = (page: Page, label: string) =>
  page.getByRole('button', { name: `Preview context ${label}`, exact: true });

// Keep expected wire payloads independent of the production context builders.
function referenceText(path: string, directory = false) {
  return `${directory ? 'Folder' : 'File'} reference (disk only)\n${directory ? 'Folder' : 'File'}: ${JSON.stringify(path)}\nNo file contents are attached. This disk reference excludes unsaved editor text. Read from disk if needed under the conversation's existing permissions.`;
}
function snapshotText(
  path: string,
  text: string,
  dirty = true,
  lines?: [number, number],
  offsets?: [number, number],
) {
  return [
    lines ? 'Frozen editor selection snapshot' : 'Frozen editor snapshot',
    `File: ${JSON.stringify(path)}`,
    ...(lines ? [`Lines: ${lines[0]}–${lines[1]}`] : []),
    ...(offsets
      ? [`Editor offsets (UTF-16, end exclusive): ${offsets[0]}–${offsets[1]}`]
      : []),
    `Unsaved edits at capture: ${dirty ? 'yes' : 'no'}`,
    'This is captured editor text and may include unsaved edits. Capturing it does not save or modify disk. It will not automatically refresh.',
    'Captured text follows verbatim:',
    '',
    text,
  ].join('\n');
}
const block = (label: string, text: string) =>
  `\n\n--- Context: ${label} ---\n${text}`;

async function commands(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window as any).testAgentCalls.filter((c: any) => c.command === name),
    command,
  );
}
async function fileOperations(page: Page) {
  return page.evaluate(() =>
    (window as any).testAgentCalls
      .filter((c: any) => /^file_(read|stat|save)$/.test(c.command))
      .map((c: any) => ({ command: c.command, args: c.args })),
  );
}
async function seedFiles(page: Page, files: Record<string, string>) {
  await page.evaluate((entries) => {
    const w = window as any;
    for (const [path, text] of Object.entries(entries))
      w.testDiskChange(path, text);
  }, files);
}
async function openFile(page: Page, path = 'hello.txt') {
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: path, exact: true })
    .click();
  await expect(page.locator('.file-toolbar')).toContainText(path);
}
async function edit(page: Page, text: string) {
  // Queue cards also have an Edit button; only toggle the file's editor here.
  const start = page
    .locator('.file-toolbar')
    .getByRole('button', { name: 'Edit', exact: true });
  if (await start.isVisible()) await start.click();
  await page.locator('.cm-content').fill(text);
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
}
async function addContext(page: Page, kind: 'reference' | 'snapshot') {
  await contextButton(page).click();
  await picker(page)
    .getByRole('radio', {
      name: kind === 'reference' ? 'File reference' : 'Editor snapshot',
      exact: true,
    })
    .check();
  await picker(page)
    .getByRole('button', {
      name:
        kind === 'reference'
          ? /^(Add|Update) file reference$/
          : /^(Add|Update) editor snapshot$/,
    })
    .click();
  await expect(picker(page)).toHaveCount(0);
}
async function copiedContext(page: Page, label: string) {
  await chip(page, label).click();
  await preview(page).getByRole('button', { name: 'Copy context' }).click();
  const text = await page.evaluate(() => (window as any).testContextClipboard);
  await preview(page)
    .getByRole('button', { name: 'Close context preview' })
    .click();
  return text as string;
}
async function setupHarness(page: Page, harness: 'codex' | 'claude') {
  if (harness === 'claude') {
    await installClaudeFixture(page);
    await connectClaude(page);
    await page
      .getByRole('combobox', { name: 'Agent', exact: true })
      .selectOption('claude');
  }
}

// All special disk, clipboard and agent behavior stays local to this spec.
test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).testContextClipboard = text;
        },
      },
    });
  });
});

for (const harness of ['codex', 'claude'] as const) {
  test(`${harness}: explicitly captured dirty text is frozen in the actual send payload and never saved`, async ({
    page,
  }) => {
    await openProject(page);
    await setupHarness(page, harness);
    await openFile(page);
    const captured = 'unsaved α\n<script>literal, never executed</script>\n';
    await edit(page, captured);
    await prompt(page).fill('Explain the captured version');
    const before = await fileOperations(page);
    await contextButton(page).click();
    await expect(
      picker(page).getByRole('radio', { name: 'Editor snapshot', exact: true }),
    ).toBeChecked();
    await expect(picker(page)).toContainText(/unsaved/i);
    await picker(page)
      .getByRole('button', { name: 'Add editor snapshot', exact: true })
      .click();
    await chip(page, snapshotLabel()).click();
    await expect(preview(page).locator('pre')).toHaveText(
      snapshotText('hello.txt', captured),
    );
    await expect(preview(page).locator('script')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await edit(page, 'a newer unsaved buffer that must not leak');
    await seedFiles(page, { 'hello.txt': 'a newer disk version' });
    expect(await copiedContext(page, snapshotLabel())).toBe(
      snapshotText('hello.txt', captured),
    );
    expect(await fileOperations(page)).toEqual(before);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
    const [sent] = await commands(page, 'agent_start_turn');
    expect(sent.args.harness).toBe(harness);
    expect(sent.args.prompt).toBe(
      'Explain the captured version' +
        block(snapshotLabel(), snapshotText('hello.txt', captured)),
    );
    expect(await commands(page, 'file_save')).toEqual([]);
    await expect(page.locator('.cm-content')).toContainText(
      'a newer unsaved buffer that must not leak',
    );
  });

  test(`${harness}: file reference is an explicit disk-only choice even with dirty edits`, async ({
    page,
  }) => {
    await openProject(page);
    await setupHarness(page, harness);
    await openFile(page);
    await edit(page, 'PRIVATE_UNSAVED_MARKER');
    const before = await fileOperations(page);
    await addContext(page, 'reference');
    expect(await copiedContext(page, 'hello.txt')).toBe(
      referenceText('hello.txt'),
    );
    expect(await fileOperations(page)).toEqual(before);
    await prompt(page).fill('Read this file if needed');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
    const [sent] = await commands(page, 'agent_start_turn');
    expect(sent.args.harness).toBe(harness);
    expect(sent.args.prompt).toBe(
      'Read this file if needed' +
        block('hello.txt', referenceText('hello.txt')),
    );
    expect(sent.args.prompt).not.toContain('PRIVATE_UNSAVED_MARKER');
    expect(sent.args.prompt).not.toContain('before\n');
    expect(await commands(page, 'file_save')).toEqual([]);
  });
}

test('clean files default to a reference; Cancel and Escape restore focus and block global shortcuts', async ({
  page,
}) => {
  await openProject(page);
  await expect(contextButton(page)).toBeDisabled();
  await openFile(page);
  await prompt(page).fill('Keep this untouched');
  const before = await fileOperations(page);
  await contextButton(page).focus();
  await contextButton(page).press('Enter');
  await expect(
    picker(page).getByRole('radio', { name: 'File reference', exact: true }),
  ).toBeChecked();
  await page.keyboard.press('Meta+k');
  await page.keyboard.press('Meta+4');
  await page.keyboard.press('Control+Enter');
  await expect(picker(page)).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Search actions, tasks, and files' }),
  ).toHaveCount(0);
  expect(await commands(page, 'agent_start_turn')).toEqual([]);
  await picker(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(contextButton(page)).toBeFocused();
  await contextButton(page).click();
  await page.keyboard.press('Escape');
  await expect(contextButton(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('Keep this untouched');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(0);
  expect(await fileOperations(page)).toEqual(before);
});

test('preview supports explicit refresh, full copy, removal and keyboard focus return', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'first capture');
  await addContext(page, 'snapshot');
  await edit(page, 'explicitly refreshed capture');
  const before = await fileOperations(page);
  const trigger = chip(page, snapshotLabel());
  await trigger.focus();
  await trigger.press('Enter');
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'first capture'),
  );
  await preview(page)
    .getByRole('button', { name: 'Update from editor' })
    .click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'explicitly refreshed capture'),
  );
  await preview(page).getByRole('button', { name: 'Copy context' }).click();
  expect(await page.evaluate(() => (window as any).testContextClipboard)).toBe(
    snapshotText('hello.txt', 'explicitly refreshed capture'),
  );
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await preview(page)
    .getByRole('button', { name: 'Close context preview' })
    .click();
  await expect(trigger).toBeFocused();
  await prompt(page).fill('Preserve this message');
  await trigger.click();
  await preview(page)
    .getByRole('button', { name: 'Remove context', exact: true })
    .click();
  await expect(preview(page)).toHaveCount(0);
  await expect(trigger).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('Preserve this message');
  await expect(prompt(page)).toBeFocused();
  expect(await fileOperations(page)).toEqual(before);
});

test('reference can be explicitly replaced with the loaded editor snapshot', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'conversion keeps unsaved text');
  await addContext(page, 'reference');
  await chip(page, 'hello.txt').click();
  await expect(preview(page)).toContainText(/disk only/i);
  await preview(page)
    .getByRole('button', { name: 'Replace with editor snapshot' })
    .click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'conversion keeps unsaved text'),
  );
  await page.keyboard.press('Escape');
  await expect(chip(page, 'hello.txt')).toHaveCount(0);
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  expect(await commands(page, 'file_save')).toEqual([]);
});

test('repeat adds replace only the same source kind; unrelated quoted context survives', async ({
  page,
}) => {
  await openProject(page);
  await prompt(page).fill('Give me a response to quote');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Quote in reply' }).click();
  await openFile(page);
  await addContext(page, 'reference');
  await contextButton(page).click();
  await expect(
    picker(page).getByRole('button', { name: 'Update file reference' }),
  ).toBeVisible();
  await picker(page)
    .getByRole('button', { name: 'Update file reference' })
    .click();
  await edit(page, 'first snapshot');
  await addContext(page, 'snapshot');
  await edit(page, 'second snapshot');
  await contextButton(page).click();
  await expect(
    picker(page).getByRole('button', { name: 'Update editor snapshot' }),
  ).toBeVisible();
  await picker(page)
    .getByRole('button', { name: 'Update editor snapshot' })
    .click();
  await expect(chip(page, 'Codex response')).toHaveCount(1);
  await expect(chip(page, 'hello.txt')).toHaveCount(1);
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  const quote = await copiedContext(page, 'Codex response');
  await prompt(page).fill('Compare these sources');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(2);
  expect((await commands(page, 'agent_start_turn'))[1].args.prompt).toBe(
    'Compare these sources' +
      block('Codex response', quote) +
      block('hello.txt', referenceText('hello.txt')) +
      block(snapshotLabel(), snapshotText('hello.txt', 'second snapshot')),
  );
});

test('selection captures exact text and inclusive range, dedupes the same range, and never silently refreshes', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'first line\nsecond line\nthird line');
  const editor = page.locator('.cm-content');
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const selectFirstLine = async () => {
    await editor.focus();
    await editor.press(mac ? 'Meta+ArrowUp' : 'Control+Home');
    // Include the line break, with the exclusive endpoint at line 2's start.
    for (let i = 0; i < 'first line\n'.length; i++)
      await editor.press('Shift+ArrowRight');
    await page
      .getByRole('button', { name: 'Add selection to message', exact: true })
      .click();
  };
  const before = await fileOperations(page);
  await selectFirstLine();
  await selectFirstLine();
  const label = 'hello.txt · lines 1–1';
  await expect(chip(page, label)).toHaveCount(1);
  await chip(page, label).click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'first line\n', true, [1, 1], [0, 11]),
  );
  await expect(
    preview(page).getByRole('button', { name: 'Update from editor' }),
  ).toHaveCount(0);
  await expect(preview(page)).toContainText(/reselect|select.*again/i);
  await page.keyboard.press('Escape');
  await edit(page, 'replacement text\ncompletely different range');
  expect(await copiedContext(page, label)).toBe(
    snapshotText('hello.txt', 'first line\n', true, [1, 1], [0, 11]),
  );
  expect(await fileOperations(page)).toEqual(before);
  await prompt(page).fill('Explain these exact lines');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    'Explain these exact lines' +
      block(
        label,
        snapshotText('hello.txt', 'first line\n', true, [1, 1], [0, 11]),
      ),
  );
});

test('file picker freezes its opening file and text even if editor navigation completes behind it', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'captured before navigation');
  await contextButton(page).click();
  // Model an already-dispatched navigation completing while the modal is open.
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'README.md', exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('.file-toolbar')).toContainText('README.md');
  await picker(page)
    .getByRole('button', { name: 'Add editor snapshot' })
    .click();
  expect(await copiedContext(page, snapshotLabel())).toBe(
    snapshotText('hello.txt', 'captured before navigation'),
  );
  await chip(page, snapshotLabel()).click();
  await expect(
    preview(page).getByRole('button', { name: 'Update from editor' }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
});

test('failed sends preserve the exact frozen context, prompt, and attachments for retry', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'failed-send frozen version');
  await addContext(page, 'snapshot');
  await prompt(page).fill('Keep my complete draft');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.evaluate(
    () => ((window as any).testSendError = 'Context send failed'),
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Context send failed');
  await expect(prompt(page)).toHaveValue('Keep my complete draft');
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Remove attachment brief.md' }),
  ).toBeVisible();
  await edit(page, 'newer buffer after failure');
  await page.evaluate(() => ((window as any).testSendError = null));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(2);
  const calls = await commands(page, 'agent_start_turn');
  expect(calls[1].args.prompt).toBe(calls[0].args.prompt);
  expect(calls[1].args.prompt).toBe(
    'Keep my complete draft' +
      block(
        snapshotLabel(),
        snapshotText('hello.txt', 'failed-send frozen version'),
      ),
  );
  expect(calls[1].args.attachmentIds).toEqual(['brief', 'screen']);
  expect(await commands(page, 'file_save')).toEqual([]);
});

for (const harness of ['codex', 'claude'] as const) {
  test(`${harness}: a multi-step queue keeps snapshots frozen while a different draft captures newer editor text`, async ({
    page,
  }) => {
    if (harness === 'codex') await concurrentFixture(page);
    else {
      await openProject(page);
      await setupHarness(page, harness);
    }
    await prompt(page).fill('Keep the first turn running');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await openFile(page);
    await edit(page, 'version belonging to queued message');
    await addContext(page, 'snapshot');
    await prompt(page).fill('Queued frozen request');
    await page
      .getByRole('button', {
        name: harness === 'claude' ? 'Send' : 'Queue for next turn',
        exact: true,
      })
      .click();
    const queue = page.locator('.queue-card');
    await expect(queue).toContainText(snapshotLabel());
    const writeAnother = page.getByRole('button', {
      name: 'Write another message',
    });
    if (await writeAnother.isVisible()) await writeAnother.click();
    await addContext(page, 'reference');
    await prompt(page).fill('Read the disk in the second queued step');
    await page
      .getByRole('button', {
        name: harness === 'claude' ? 'Send' : 'Queue for next turn',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('region', { name: 'Task queue', exact: true }),
    ).toBeVisible();
    await queue
      .getByRole('button', { name: 'Show all 2', exact: true })
      .click();
    await expect(queue.getByRole('listitem')).toHaveCount(2);
    if (await writeAnother.isVisible()) await writeAnother.click();
    await edit(page, 'version belonging to a separate unsent draft');
    await expect(queue).toContainText('Queued frozen request');
    await addContext(page, 'snapshot');
    await expect(queue).toContainText('Queued frozen request');
    await prompt(page).fill('Keep this newer draft');
    await page.evaluate((agent) => {
      const w = window as any;
      w.testDiskChange('hello.txt', 'disk changes after queue capture');
      if (agent === 'claude') w.testClaudeFinish();
      else w.concurrentFinish('concurrent-1');
    }, harness);
    await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(2);
    const calls = await commands(page, 'agent_start_turn');
    expect(calls[1].args.prompt).toBe(
      'Queued frozen request' +
        block(
          snapshotLabel(),
          snapshotText('hello.txt', 'version belonging to queued message'),
        ),
    );
    await expect(queue.getByRole('listitem')).toHaveCount(1);
    await expect(queue).toContainText(
      'Read the disk in the second queued step',
    );
    await page.evaluate((agent) => {
      const w = window as any;
      if (agent === 'claude') w.testClaudeFinish();
      else w.concurrentFinish('concurrent-1');
    }, harness);
    await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(3);
    expect((await commands(page, 'agent_start_turn'))[2].args.prompt).toBe(
      'Read the disk in the second queued step' +
        block('hello.txt', referenceText('hello.txt')),
    );
    await expect(queue).toHaveCount(0);
    expect(await commands(page, 'agent_steer_turn')).toEqual([]);
    await expect(prompt(page)).toHaveValue('Keep this newer draft');
    expect(await copiedContext(page, snapshotLabel())).toBe(
      snapshotText('hello.txt', 'version belonging to a separate unsent draft'),
    );
    expect(await commands(page, 'file_save')).toEqual([]);
  });
}

test('background task queue uses its own frozen context and never borrows the foreground draft', async ({
  page,
}) => {
  await concurrentFixture(page);
  await prompt(page).fill('Background context owner');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await openFile(page);
  await edit(page, 'background captured text');
  await addContext(page, 'snapshot');
  await prompt(page).fill('Background follow-up');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await prompt(page).fill('Foreground task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await openFile(page);
  await edit(page, 'foreground captured text');
  await addContext(page, 'snapshot');
  await prompt(page).fill('Unsent foreground draft');
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(3);
  const calls = await commands(page, 'agent_start_turn');
  expect(calls[2].args.threadId).toMatch(/(?:codex:)?concurrent-1$/);
  expect(calls[2].args.prompt).toBe(
    'Background follow-up' +
      block(
        snapshotLabel(),
        snapshotText('hello.txt', 'background captured text'),
      ),
  );
  await expect(prompt(page)).toHaveValue('Unsent foreground draft');
  expect(await copiedContext(page, snapshotLabel())).toBe(
    snapshotText('hello.txt', 'foreground captured text'),
  );
  await switchTask(page, 'Background context owner');
  await expect(prompt(page)).toHaveValue('');
  await expect(chip(page, snapshotLabel())).toHaveCount(0);
  await switchTask(page, 'Foreground task');
  await expect(prompt(page)).toHaveValue('Unsent foreground draft');
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
});

test('failed live steering preserves both a frozen draft and a distinct queued message', async ({
  page,
}) => {
  await concurrentFixture(page);
  await prompt(page).fill('Running context task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await openFile(page);
  await edit(page, 'queued first');
  await addContext(page, 'snapshot');
  await prompt(page).fill('Queued request');
  await page.getByRole('button', { name: 'Queue for next turn' }).click();
  const writeAnother = page.getByRole('button', {
    name: 'Write another message',
  });
  if (await writeAnother.isVisible()) await writeAnother.click();
  await edit(page, 'frozen steering request');
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Queued request');
  await addContext(page, 'snapshot');
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Queued request');
  await prompt(page).fill('Immediate correction');
  await page.evaluate(
    () => ((window as any).testSteerError = 'Input not accepted'),
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(prompt(page)).toHaveValue('Immediate correction');
  await expect(
    page.getByText(/Message not confirmed. Your draft is restored/),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Queued request');
  expect(await copiedContext(page, snapshotLabel())).toBe(
    snapshotText('hello.txt', 'frozen steering request'),
  );
  await edit(page, 'do not substitute this later buffer');
  await page.evaluate(() => ((window as any).testSteerError = null));
  await prompt(page).press('Control+Enter');
  await expect.poll(() => commands(page, 'agent_steer_turn')).toHaveLength(2);
  const steers = await commands(page, 'agent_steer_turn');
  expect(steers[1].args.prompt).toBe(steers[0].args.prompt);
  expect(steers[1].args.prompt).toBe(
    'Immediate correction' +
      block(
        snapshotLabel(),
        snapshotText('hello.txt', 'frozen steering request'),
      ),
  );
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Queued request');
  expect(await commands(page, 'agent_interrupt_turn')).toEqual([]);
});

test('preview shortening is honest while copy and send preserve every captured character', async ({
  page,
}) => {
  const body = 'α'.repeat(16000) + 'TAIL_MUST_BE_SENT';
  await seedFiles(page, { 'long.txt': body });
  await openProject(page);
  await openFile(page, 'long.txt');
  await contextButton(page).click();
  await picker(page)
    .getByRole('radio', { name: 'Editor snapshot', exact: true })
    .check();
  await expect(picker(page)).toContainText(
    'Preview shortened to the first 12,000 characters',
  );
  await expect(picker(page)).toContainText(
    'The full context will be included.',
  );
  await picker(page)
    .getByRole('button', { name: 'Add editor snapshot' })
    .click();
  const expected = snapshotText('long.txt', body, false);
  // A safe ASCII snapshot exceeds the larger dialog's 30,000-character cap.
  // Its copy and outgoing payload must still contain the complete tail.
  await edit(page, 'P'.repeat(31000) + 'TAIL_MUST_BE_SENT');
  await chip(page, snapshotLabel('long.txt')).click();
  await expect(preview(page).locator('pre')).toHaveText(expected);
  await expect(preview(page).locator('.context-provenance')).toContainText(
    'Saved editor buffer',
  );
  await preview(page)
    .getByRole('button', { name: 'Update from editor' })
    .click();
  const full = snapshotText(
    'long.txt',
    'P'.repeat(31000) + 'TAIL_MUST_BE_SENT',
  );
  await expect(preview(page).locator('pre')).toHaveText(full.slice(0, 30000));
  await expect(preview(page)).toContainText(
    'Preview shortened to the first 30,000 characters',
  );
  await expect(preview(page)).toContainText('The full context stays attached');
  await expect(preview(page).locator('.context-provenance')).toContainText(
    `${new TextEncoder().encode(full).length.toLocaleString('en-US')} bytes`,
  );
  await preview(page).getByRole('button', { name: 'Copy context' }).click();
  expect(await page.evaluate(() => (window as any).testContextClipboard)).toBe(
    full,
  );
  await preview(page).getByRole('button', { name: 'Back to message' }).click();
  await prompt(page).fill('Inspect all of it');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    'Inspect all of it' + block(snapshotLabel('long.txt'), full),
  );
});

test('the 64 KiB cap counts UTF-8 and source headers, refuses overflow, and preserves an existing snapshot', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  const headerBytes = new TextEncoder().encode(
    snapshotText('hello.txt', ''),
  ).length;
  const body = 'a'.repeat(64 * 1024 - headerBytes);
  await edit(page, body);
  await addContext(page, 'snapshot');
  const original = await copiedContext(page, snapshotLabel());
  expect(new TextEncoder().encode(original).length).toBe(64 * 1024);
  await prompt(page).fill('Never discard this draft');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await edit(page, body + 'b');
  await chip(page, snapshotLabel()).click();
  await preview(page)
    .getByRole('button', { name: 'Update from editor' })
    .click();
  await expect(preview(page).getByRole('alert')).toContainText('64 KiB');
  await preview(page).getByRole('button', { name: 'Copy context' }).click();
  expect(await page.evaluate(() => (window as any).testContextClipboard)).toBe(
    original,
  );
  await page.keyboard.press('Escape');
  await expect(prompt(page)).toHaveValue('Never discard this draft');
  await expect(
    page.getByRole('button', { name: 'Remove attachment brief.md' }),
  ).toBeVisible();
  // 34,000 UTF-16 code units still exceed 64 KiB when encoded as UTF-8.
  await edit(page, '😀'.repeat(17000));
  await contextButton(page).click();
  await expect(
    picker(page).getByRole('radio', { name: 'Editor snapshot', exact: true }),
  ).toBeDisabled();
  await expect(picker(page)).toContainText('64 KiB');
  await expect(
    picker(page).getByRole('radio', { name: 'File reference', exact: true }),
  ).toBeChecked();
  await picker(page)
    .getByRole('button', { name: 'Add file reference' })
    .click();
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  await expect(chip(page, 'hello.txt')).toHaveCount(1);
  expect(await commands(page, 'file_save')).toEqual([]);
});

test('aggregate overflow refuses an add and a replacement atomically without changing draft sources', async ({
  page,
}) => {
  await seedFiles(page, {
    'one.txt': '1'.repeat(44000),
    'two.txt': '2'.repeat(44000),
    'three.txt': '3'.repeat(44000),
  });
  await openProject(page);
  for (const path of ['one.txt', 'two.txt']) {
    await openFile(page, path);
    await addContext(page, 'snapshot');
  }
  await openFile(page, 'three.txt');
  await contextButton(page).click();
  await picker(page)
    .getByRole('radio', { name: 'Editor snapshot', exact: true })
    .check();
  await picker(page)
    .getByRole('button', { name: 'Add editor snapshot' })
    .click();
  await expect(picker(page).getByRole('alert')).toContainText('128 KiB');
  await picker(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(2);
  await edit(page, '3'.repeat(100));
  await addContext(page, 'snapshot');
  await prompt(page).fill('All three original snapshots matter');
  const original = await copiedContext(page, snapshotLabel('three.txt'));
  await edit(page, 'R'.repeat(44000));
  await contextButton(page).click();
  await picker(page)
    .getByRole('button', { name: 'Update editor snapshot' })
    .click();
  await expect(picker(page).getByRole('alert')).toContainText('128 KiB');
  await picker(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  expect(await copiedContext(page, snapshotLabel('three.txt'))).toBe(original);
  await chip(page, snapshotLabel('three.txt')).click();
  await preview(page)
    .getByRole('button', { name: 'Update from editor' })
    .click();
  await expect(preview(page).getByRole('alert')).toContainText('128 KiB');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(3);
  await expect(prompt(page)).toHaveValue('All three original snapshots matter');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    'All three original snapshots matter' +
      block(
        snapshotLabel('one.txt'),
        snapshotText('one.txt', '1'.repeat(44000), false),
      ) +
      block(
        snapshotLabel('two.txt'),
        snapshotText('two.txt', '2'.repeat(44000), false),
      ) +
      block(snapshotLabel('three.txt'), original),
  );
});

test('four frozen sources include selections; a fifth source is refused while same-source replacement still works', async ({
  page,
}) => {
  await seedFiles(page, {
    'one.txt': 'one',
    'two.txt': 'two',
    'three.txt': 'three',
    'four.txt': 'four\nnext',
  });
  await openProject(page);
  for (const path of ['one.txt', 'two.txt', 'three.txt']) {
    await openFile(page, path);
    await addContext(page, 'snapshot');
  }
  await openFile(page, 'four.txt');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').focus();
  await page.locator('.cm-content').press('Shift+ArrowRight');
  await page
    .getByRole('button', { name: 'Add selection to message', exact: true })
    .click();
  await expect(chip(page, 'four.txt · lines 1–1')).toHaveCount(1);
  await prompt(page).fill('Keep four sources');
  await contextButton(page).click();
  await picker(page)
    .getByRole('radio', { name: 'Editor snapshot', exact: true })
    .check();
  await picker(page)
    .getByRole('button', { name: 'Add editor snapshot' })
    .click();
  await expect(picker(page).getByRole('alert')).toContainText('at most 4');
  await picker(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(4);
  await expect(chip(page, snapshotLabel('four.txt'))).toHaveCount(0);
  await openFile(page, 'one.txt');
  await edit(page, 'one explicitly replaced at capacity');
  await addContext(page, 'snapshot');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(4);
  expect(await copiedContext(page, snapshotLabel('one.txt'))).toBe(
    snapshotText('one.txt', 'one explicitly replaced at capacity'),
  );
  await expect(prompt(page)).toHaveValue('Keep four sources');
});

async function addExplorerReference(page: Page, path: string) {
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: path, exact: true })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Add to chat', exact: true })
    .click();
}

test('Explorer references are explicit, lightweight, deduplicated, and capped at sixteen without reading files', async ({
  page,
}) => {
  const paths = Array.from(
    { length: 17 },
    (_, i) => `ref-${String(i + 1).padStart(2, '0')}.txt`,
  );
  await seedFiles(
    page,
    Object.fromEntries(paths.map((path) => [path, `DO_NOT_READ_${path}`])),
  );
  await openProject(page);
  await prompt(page).fill('Preserve reference draft');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  for (const path of paths.slice(0, 16)) await addExplorerReference(page, path);
  await addExplorerReference(page, paths[0]);
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(16);
  await addExplorerReference(page, paths[16]);
  await expect(page.getByRole('alert')).toContainText('at most 16');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(16);
  await expect(chip(page, paths[16])).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('Preserve reference draft');
  await expect(
    page.getByRole('button', { name: 'Remove attachment brief.md' }),
  ).toBeVisible();
  await chip(page, paths[0]).click();
  await expect(preview(page).locator('.context-provenance')).toContainText(
    'File reference',
  );
  await expect(preview(page).locator('pre')).toHaveText(
    referenceText(paths[0]),
  );
  await expect(
    preview(page).getByRole('button', { name: 'Replace with editor snapshot' }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(await fileOperations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  const [sent] = await commands(page, 'agent_start_turn');
  expect(sent.args.prompt).toBe(
    'Preserve reference draft' +
      paths
        .slice(0, 16)
        .map((path) => block(path, referenceText(path)))
        .join(''),
  );
  expect(sent.args.attachmentIds).toEqual(['brief', 'screen']);
  expect(sent.args.prompt).not.toContain('DO_NOT_READ_');
});

test('Explorer folders stay references and @ mentions remain plain paths, with no snapshots or disk reads', async ({
  page,
}) => {
  await openProject(page);
  await addExplorerReference(page, 'src');
  await chip(page, 'src').click();
  await expect(preview(page).locator('.context-provenance')).toContainText(
    'Folder reference',
  );
  await expect(preview(page).locator('pre')).toHaveText(
    referenceText('src', true),
  );
  await expect(
    preview(page).getByRole('button', { name: 'Replace with editor snapshot' }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await prompt(page).click();
  await page.keyboard.type('Inspect @hel');
  await page
    .getByRole('listbox', { name: 'Files to mention' })
    .getByRole('option', { name: /hello\.txt/ })
    .click();
  await expect(prompt(page)).toHaveValue('Inspect @hello.txt ');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(1);
  expect(await fileOperations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  // A mention stays ordinary prompt text; no file content is expanded.
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    'Inspect @hello.txt ' + block('src', referenceText('src', true)),
  );
});

for (const encoding of ['binary', 'tooLarge']) {
  test(`${encoding} files explain why snapshots are unavailable and require an explicit reference choice`, async ({
    page,
  }) => {
    await seedFiles(page, { 'unavailable.dat': 'fixture metadata only' });
    await page.evaluate((kind) => {
      const w = window as any;
      const previous = w.testAgentInvoke;
      w.testAgentInvoke = (command: string, args: any) => {
        if (
          command === 'file_read' &&
          args.relativePath === 'unavailable.dat'
        ) {
          return {
            path: 'unavailable.dat',
            content: null,
            encoding: kind,
            sizeBytes: kind === 'binary' ? 512 : 6 * 1024 * 1024,
            newline: 'lf',
            fingerprint: {
              sizeBytes: 512,
              modifiedNanos: 1,
              hash: 'unavailable',
            },
            readOnlyRecommended: true,
          };
        }
        return previous?.(command, args);
      };
    }, encoding);
    await openProject(page);
    await openFile(page, 'unavailable.dat');
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await prompt(page).fill('Use the reference only');
    const before = await fileOperations(page);
    await contextButton(page).click();
    await expect(
      picker(page).getByRole('radio', { name: 'Editor snapshot', exact: true }),
    ).toBeDisabled();
    await expect(picker(page).getByRole('status')).toContainText(
      /readable text|binary|large|buffer/i,
    );
    await expect(picker(page)).toContainText(
      'You can still add a file reference.',
    );
    await expect(
      picker(page).getByRole('radio', { name: 'File reference', exact: true }),
    ).toBeChecked();
    await expect(chip(page, 'unavailable.dat')).toHaveCount(0);
    await picker(page)
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(chip(page, 'unavailable.dat')).toHaveCount(0);
    await addContext(page, 'reference');
    expect(await copiedContext(page, 'unavailable.dat')).toBe(
      referenceText('unavailable.dat'),
    );
    expect(await fileOperations(page)).toEqual(before);
    await expect(prompt(page)).toHaveValue('Use the reference only');
  });
}

test('an empty readable file can be captured, previewed and sent without inventing contents', async ({
  page,
}) => {
  await seedFiles(page, { 'empty.txt': '' });
  await openProject(page);
  await openFile(page, 'empty.txt');
  const before = await fileOperations(page);
  await addContext(page, 'snapshot');
  const expected = snapshotText('empty.txt', '', false);
  expect(await copiedContext(page, snapshotLabel('empty.txt'))).toBe(expected);
  expect(await fileOperations(page)).toEqual(before);
  // Context-only sends must work even when the actual captured body is empty.
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    block(snapshotLabel('empty.txt'), expected),
  );
});

test('a pending picker cannot attach its capture to a newer conversation, and existing drafts stay isolated', async ({
  page,
}) => {
  await openProject(page);
  await setupHarness(page, 'claude');
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption('codex');
  await openFile(page);
  await edit(page, 'Codex draft capture');
  await addContext(page, 'snapshot');
  await prompt(page).fill('Keep Codex draft');
  await contextButton(page).click();
  // An asynchronous navigation can complete after the picker captured its owner.
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .evaluate((select: HTMLSelectElement) => {
      select.value = 'claude';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await expect(picker(page)).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(0);
  await prompt(page).fill('Keep Claude draft');
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption('codex');
  await expect(prompt(page)).toHaveValue('Keep Codex draft');
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  expect(await copiedContext(page, snapshotLabel())).toBe(
    snapshotText('hello.txt', 'Codex draft capture'),
  );
  expect(await commands(page, 'agent_start_turn')).toEqual([]);
});

test('context dialogs stay usable in a small window and do no idle disk work', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await openProject(page);
  await openFile(page);
  await edit(page, 'usable with keyboard and a small window');
  const before = await fileOperations(page);
  await contextButton(page).click();
  await expect(
    picker(page).getByRole('radio', { name: 'Editor snapshot', exact: true }),
  ).toBeFocused();
  await expect(
    picker(page).getByRole('button', { name: 'Add editor snapshot' }),
  ).toBeInViewport();
  await expect(
    picker(page).getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeInViewport();
  await picker(page)
    .getByRole('button', { name: 'Add editor snapshot' })
    .click();
  await chip(page, snapshotLabel()).click();
  await expect(
    preview(page).getByRole('textbox', { name: 'Context text' }),
  ).toHaveAttribute('aria-readonly', 'true');
  await expect(
    preview(page).getByRole('button', { name: 'Copy context' }),
  ).toBeInViewport();
  await expect(
    preview(page).getByRole('button', { name: 'Remove context', exact: true }),
  ).toBeInViewport();
  await expect(
    preview(page).getByRole('button', { name: 'Back to message' }),
  ).toBeInViewport();
  // This is deliberately an idle interval: opening a preview must not start a poller.
  await page.waitForTimeout(1100);
  expect(await fileOperations(page)).toEqual(before);
  await preview(page).getByRole('button', { name: 'Back to message' }).click();
  await expect(chip(page, snapshotLabel())).toBeFocused();
});

test('a clean snapshot survives a real disk reload until explicit refresh', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await addContext(page, 'snapshot');
  await page.evaluate(() => {
    (window as any).testDiskChange('hello.txt', 'reloaded disk contents\n');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('.cm-content')).toContainText(
    'reloaded disk contents',
  );
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  expect(await copiedContext(page, snapshotLabel())).toBe(
    snapshotText('hello.txt', 'before\n', false),
  );
  const afterReload = await fileOperations(page);
  await chip(page, snapshotLabel()).click();
  await preview(page)
    .getByRole('button', { name: 'Update from editor' })
    .click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'reloaded disk contents\n', false),
  );
  await page.keyboard.press('Escape');
  expect(await fileOperations(page)).toEqual(afterReload);
  expect(await commands(page, 'file_save')).toEqual([]);
});

test('a snapshot-only draft protects its project; explicitly removing it permits a switch and new source identity', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any;
    w.testRecentProjects = ['/fixture/other-project'];
    w.testAgentInvoke = (command: string, args: any) => {
      if (command === 'project_open' && args.path === '/fixture/other-project')
        return {
          root: args.path,
          displayName: 'other-project',
          git: {
            available: false,
            branch: '',
            head: '',
            files: [],
            unstaged: '',
            staged: '',
            truncated: false,
          },
        };
    };
  });
  await openProject(page);
  await openFile(page);
  await addContext(page, 'snapshot');
  await page.locator('.project-button').click();
  await page
    .getByRole('dialog', { name: 'Switch project' })
    .getByRole('option')
    .filter({ hasText: '/fixture/other-project' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Switch project' }),
  ).toHaveCount(0);
  await expect(page.locator('.project-button')).toContainText(
    'fixture-project',
  );
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  expect(await copiedContext(page, snapshotLabel())).toBe(
    snapshotText('hello.txt', 'before\n', false),
  );
  expect(
    (await commands(page, 'window_open')).map((call: any) => call.args.path),
  ).toEqual(['/fixture/other-project']);
  expect(await commands(page, 'project_open')).toHaveLength(1);
  await page
    .getByRole('button', { name: `Remove ${snapshotLabel()}`, exact: true })
    .click();
  await page.locator('.project-button').click();
  await page
    .getByRole('dialog', { name: 'Switch project' })
    .getByRole('option')
    .filter({ hasText: '/fixture/other-project' })
    .click();
  await expect(page.locator('.project-button')).toContainText('other-project');
  await expect(
    page.getByRole('button', { name: /^Preview context / }),
  ).toHaveCount(0);
  await openFile(page);
  await addContext(page, 'reference');
  const text = await copiedContext(page, 'hello.txt');
  expect(text).toBe(referenceText('hello.txt'));
  expect(text).not.toContain('/fixture/');
  await chip(page, 'hello.txt').click();
  await expect(preview(page).locator('.context-provenance')).toContainText(
    '/fixture/other-project',
  );
  await expect(preview(page).locator('.context-provenance')).not.toContainText(
    ROOT,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    block('hello.txt', text),
  );
});

test('consecutive explicit editor refreshes retain a usable preview and send the final captured version', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'original attachment');
  await addContext(page, 'snapshot');
  await edit(page, 'first refreshed version');
  const before = await fileOperations(page);
  await chip(page, snapshotLabel()).click();
  const refresh = preview(page).getByRole('button', {
    name: 'Update from editor',
  });
  for (let i = 0; i < 3; i++) {
    await refresh.click();
    await expect(preview(page).locator('pre')).toHaveText(
      snapshotText('hello.txt', 'first refreshed version'),
    );
    await expect(preview(page).getByRole('alert')).toHaveCount(0);
    await expect(preview(page).getByRole('status')).toContainText(
      'Editor snapshot updated.',
    );
  }
  await page.keyboard.press('Escape');
  await edit(page, 'final explicitly refreshed version');
  await chip(page, snapshotLabel()).click();
  await refresh.click();
  await refresh.click();
  await expect(preview(page).getByRole('alert')).toHaveCount(0);
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'final explicitly refreshed version'),
  );
  await page.keyboard.press('Escape');
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  expect(await fileOperations(page)).toEqual(before);
  await prompt(page).fill('Use the final capture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    'Use the final capture' +
      block(
        snapshotLabel(),
        snapshotText('hello.txt', 'final explicitly refreshed version'),
      ),
  );
});

test('reference conversion can be refreshed again in the same preview without reviving the reference', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'conversion source');
  await addContext(page, 'reference');
  await chip(page, 'hello.txt').click();
  await preview(page)
    .getByRole('button', { name: 'Replace with editor snapshot' })
    .click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'conversion source'),
  );
  const refresh = preview(page).getByRole('button', {
    name: 'Update from editor',
  });
  await refresh.click();
  await refresh.click();
  await expect(preview(page).getByRole('alert')).toHaveCount(0);
  await expect(preview(page).locator('.context-provenance')).toContainText(
    'Editor snapshot',
  );
  await page.keyboard.press('Escape');
  await expect(chip(page, 'hello.txt')).toHaveCount(0);
  await expect(chip(page, snapshotLabel())).toHaveCount(1);
  await edit(page, 'new buffer after conversion');
  await chip(page, snapshotLabel()).click();
  await refresh.click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'new buffer after conversion'),
  );
  await expect(preview(page).getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    block(
      snapshotLabel(),
      snapshotText('hello.txt', 'new buffer after conversion'),
    ),
  );
  expect(await commands(page, 'file_save')).toEqual([]);
});

async function selectEditorRange(page: Page, from: number, to: number) {
  const editor = page.locator('.cm-content');
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await editor.focus();
  await editor.press(mac ? 'Meta+ArrowUp' : 'Control+Home');
  for (let i = 0; i < from; i++) await editor.press('ArrowRight');
  for (let i = from; i < to; i++) await editor.press('Shift+ArrowRight');
  await expect(
    page.getByRole('button', { name: 'Add selection to message', exact: true }),
  ).toBeEnabled();
}

test('disjoint selections on the same line remain distinct while re-adding one exact range replaces only that selection', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'alpha beta gamma');
  const add = page.getByRole('button', {
    name: 'Add selection to message',
    exact: true,
  });
  await selectEditorRange(page, 0, 5);
  await add.click();
  await selectEditorRange(page, 6, 10);
  await add.click();
  const label = 'hello.txt · lines 1–1';
  await expect(chip(page, label)).toHaveCount(2);
  await selectEditorRange(page, 0, 5);
  await add.click();
  await expect(chip(page, label)).toHaveCount(2);
  for (const [index, text] of ['alpha', 'beta'].entries()) {
    await chip(page, label).nth(index).click();
    await expect(preview(page).locator('pre')).toHaveText(
      snapshotText(
        'hello.txt',
        text,
        true,
        [1, 1],
        index === 0 ? [0, 5] : [6, 10],
      ),
    );
    await page.keyboard.press('Escape');
  }
  await edit(page, 'new unrelated editor contents');
  await prompt(page).fill('Compare these two selections');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    'Compare these two selections' +
      block(label, snapshotText('hello.txt', 'alpha', true, [1, 1], [0, 5])) +
      block(label, snapshotText('hello.txt', 'beta', true, [1, 1], [6, 10])),
  );
  expect(await commands(page, 'file_save')).toEqual([]);
});

test('selection provenance reflects the saved state when Add is pressed, not when the range was first highlighted', async ({
  page,
}) => {
  await openProject(page);
  await openFile(page);
  await edit(page, 'alpha beta gamma');
  await selectEditorRange(page, 0, 5);
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  expect(await commands(page, 'file_save')).toHaveLength(1);
  const beforeAdd = await fileOperations(page);
  await page
    .getByRole('button', { name: 'Add selection to message', exact: true })
    .click();
  const label = 'hello.txt · lines 1–1';
  await chip(page, label).click();
  await expect(preview(page).locator('pre')).toHaveText(
    snapshotText('hello.txt', 'alpha', false, [1, 1], [0, 5]),
  );
  await expect(preview(page).locator('.context-provenance')).toContainText(
    'Saved editor buffer',
  );
  await expect(preview(page).locator('.context-provenance')).not.toContainText(
    'Unsaved editor changes',
  );
  await page.keyboard.press('Escape');
  expect(await fileOperations(page)).toEqual(beforeAdd);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands(page, 'agent_start_turn')).toHaveLength(1);
  expect((await commands(page, 'agent_start_turn'))[0].args.prompt).toBe(
    block(label, snapshotText('hello.txt', 'alpha', false, [1, 1], [0, 5])),
  );
  expect(await commands(page, 'file_save')).toHaveLength(1);
});

async function deferClipboard(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.testContextCopies = [];
    navigator.clipboard.writeText = (text: string) =>
      new Promise<void>((resolve, reject) => {
        w.testContextCopies.push({
          text,
          resolve: () => {
            w.testContextClipboard = text;
            resolve();
          },
          reject: () => reject(new Error('Deferred clipboard failure')),
        });
      });
  });
}
async function copyRequests(page: Page) {
  return page.evaluate(() =>
    (window as any).testContextCopies.map((request: any) => request.text),
  );
}
async function settleCopy(
  page: Page,
  index: number,
  outcome: 'resolve' | 'reject',
) {
  await page.evaluate(
    ({ request, result }) => {
      (window as any).testContextCopies[request][result]();
    },
    { request: index, result: outcome },
  );
}

for (const outcome of ['resolve', 'reject'] as const) {
  test(`a deferred clipboard ${outcome} after refresh cannot report stale status or start an overlapping write`, async ({
    page,
  }) => {
    await openProject(page);
    await openFile(page);
    await edit(page, 'old copy capture');
    await addContext(page, 'snapshot');
    await edit(page, 'new capture after refresh');
    await deferClipboard(page);
    await chip(page, snapshotLabel()).click();
    await preview(page).getByRole('button', { name: 'Copy context' }).click();
    const copying = preview(page).getByRole('button', {
      name: 'Copying…',
      exact: true,
    });
    await expect(copying).toBeDisabled();
    expect(await copyRequests(page)).toEqual([
      snapshotText('hello.txt', 'old copy capture'),
    ]);
    await preview(page)
      .getByRole('button', { name: 'Update from editor' })
      .click();
    await expect(preview(page).locator('pre')).toHaveText(
      snapshotText('hello.txt', 'new capture after refresh'),
    );
    await expect(copying).toBeDisabled();
    // Even a rapid repeated activation cannot overlap the pending OS write.
    await copying.evaluate((button: HTMLButtonElement) => button.click());
    expect(await copyRequests(page)).toHaveLength(1);
    await settleCopy(page, 0, outcome);
    const copy = preview(page).getByRole('button', {
      name: 'Copy context',
      exact: true,
    });
    await expect(copy).toBeEnabled();
    await expect(preview(page)).not.toContainText('Full context copied.');
    await expect(preview(page)).not.toContainText('Could not copy context.');
    await expect(preview(page).getByRole('alert')).toHaveCount(0);
    await copy.click();
    expect(await copyRequests(page)).toEqual([
      snapshotText('hello.txt', 'old copy capture'),
      snapshotText('hello.txt', 'new capture after refresh'),
    ]);
    await settleCopy(page, 1, 'resolve');
    await expect(preview(page)).toContainText('Full context copied.');
    expect(
      await page.evaluate(() => (window as any).testContextClipboard),
    ).toBe(snapshotText('hello.txt', 'new capture after refresh'));
    await page.keyboard.press('Escape');
    await expect(chip(page, snapshotLabel())).toHaveCount(1);
    expect(await commands(page, 'file_save')).toEqual([]);
  });

  test(`a deferred clipboard ${outcome} after closing stays isolated from a newly opened preview`, async ({
    page,
  }) => {
    await openProject(page);
    await openFile(page);
    await edit(page, 'closed preview capture');
    await addContext(page, 'snapshot');
    await addContext(page, 'reference');
    await prompt(page).fill('Preserve draft during clipboard operations');
    const before = await fileOperations(page);
    await deferClipboard(page);
    await chip(page, snapshotLabel()).click();
    await preview(page).getByRole('button', { name: 'Copy context' }).click();
    await expect(
      preview(page).getByRole('button', { name: 'Copying…', exact: true }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(chip(page, snapshotLabel())).toBeFocused();
    await chip(page, 'hello.txt').click();
    const copying = preview(page).getByRole('button', {
      name: 'Copying…',
      exact: true,
    });
    await expect(copying).toBeDisabled();
    await copying.evaluate((button: HTMLButtonElement) => button.click());
    expect(await copyRequests(page)).toEqual([
      snapshotText('hello.txt', 'closed preview capture'),
    ]);
    await settleCopy(page, 0, outcome);
    const copy = preview(page).getByRole('button', {
      name: 'Copy context',
      exact: true,
    });
    await expect(copy).toBeEnabled();
    await expect(preview(page).locator('pre')).toHaveText(
      referenceText('hello.txt'),
    );
    await expect(preview(page)).not.toContainText('Full context copied.');
    await expect(preview(page)).not.toContainText('Could not copy context.');
    await copy.click();
    expect(await copyRequests(page)).toEqual([
      snapshotText('hello.txt', 'closed preview capture'),
      referenceText('hello.txt'),
    ]);
    await settleCopy(page, 1, 'resolve');
    await expect(preview(page)).toContainText('Full context copied.');
    expect(
      await page.evaluate(() => (window as any).testContextClipboard),
    ).toBe(referenceText('hello.txt'));
    await preview(page)
      .getByRole('button', { name: 'Close context preview' })
      .click();
    await expect(chip(page, 'hello.txt')).toBeFocused();
    await expect(prompt(page)).toHaveValue(
      'Preserve draft during clipboard operations',
    );
    await expect(
      page.getByRole('button', { name: /^Preview context / }),
    ).toHaveCount(2);
    expect(await fileOperations(page)).toEqual(before);
  });
}

async function deferContextModule(
  page: Page,
  name: 'FileContextPicker' | 'ContextPreview',
) {
  let requested = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    new RegExp(`/src/lib/components/${name}\\.svelte(?:\\?.*)?$`),
    async (route) => {
      requested = true;
      await gate;
      await route.continue();
    },
  );
  return { requested: () => requested, release };
}

for (const dismissal of ['button', 'Escape'] as const) {
  test(`lazy file picker ${dismissal} dismissal restores focus and a late module cannot attach or reopen`, async ({
    page,
  }) => {
    const loading = await deferContextModule(page, 'FileContextPicker');
    try {
      await openProject(page);
      await openFile(page);
      await edit(page, 'capture held while picker code loads');
      await prompt(page).fill('Keep this draft during picker loading');
      const before = await fileOperations(page);
      await contextButton(page).click();
      await expect.poll(loading.requested).toBe(true);
      await expect(picker(page)).toContainText('Opening file context…');
      if (dismissal === 'button')
        await picker(page)
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
      else await page.keyboard.press('Escape');
      await expect(picker(page)).toHaveCount(0);
      await expect(contextButton(page)).toBeFocused();
      loading.release();
      await expect(
        page.getByRole('button', { name: /^Preview context / }),
      ).toHaveCount(0);
      // Reopening uses the now-resolving module, but still requires an explicit Add.
      await contextButton(page).click();
      await expect(
        picker(page).getByRole('radio', {
          name: 'Editor snapshot',
          exact: true,
        }),
      ).toBeChecked();
      await picker(page)
        .getByRole('button', { name: 'Add editor snapshot' })
        .click();
      await expect(chip(page, snapshotLabel())).toHaveCount(1);
      await expect(prompt(page)).toHaveValue(
        'Keep this draft during picker loading',
      );
      expect(await fileOperations(page)).toEqual(before);
      expect(await commands(page, 'agent_start_turn')).toEqual([]);
    } finally {
      loading.release();
    }
  });

  test(`lazy context preview ${dismissal} dismissal restores its chip and a late module leaves the draft intact`, async ({
    page,
  }) => {
    const loading = await deferContextModule(page, 'ContextPreview');
    try {
      await openProject(page);
      await openFile(page);
      await edit(page, 'frozen before preview module loads');
      await addContext(page, 'snapshot');
      await prompt(page).fill('Keep this draft during preview loading');
      const before = await fileOperations(page);
      await chip(page, snapshotLabel()).click();
      await expect.poll(loading.requested).toBe(true);
      await expect(preview(page)).toContainText('Opening context…');
      if (dismissal === 'button')
        await preview(page)
          .getByRole('button', { name: 'Back to message' })
          .click();
      else await page.keyboard.press('Escape');
      await expect(preview(page)).toHaveCount(0);
      await expect(chip(page, snapshotLabel())).toBeFocused();
      loading.release();
      await expect(prompt(page)).toHaveValue(
        'Keep this draft during preview loading',
      );
      await expect(chip(page, snapshotLabel())).toHaveCount(1);
      await chip(page, snapshotLabel()).click();
      await expect(preview(page).locator('pre')).toHaveText(
        snapshotText('hello.txt', 'frozen before preview module loads'),
      );
      await preview(page)
        .getByRole('button', { name: 'Close context preview' })
        .click();
      await expect(chip(page, snapshotLabel())).toBeFocused();
      expect(await fileOperations(page)).toEqual(before);
      expect(await commands(page, 'agent_start_turn')).toEqual([]);
    } finally {
      loading.release();
    }
  });
}
