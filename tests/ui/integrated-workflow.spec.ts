import { test, expect, type Page } from '@playwright/test';
import {
  concurrentFixture,
  connectClaude,
  installClaudeFixture,
  mockDesktop,
  switchTask,
} from './fixtures';

type Harness = 'codex' | 'claude';
const root = '/fixture/project';
const prompt = (page: Page) =>
  page.getByRole('textbox', { name: 'Task prompt' });
const queue = (page: Page) => page.locator('.queue-card');
const entries = (page: Page) => queue(page).getByRole('listitem');
const explorer = (page: Page) =>
  page.getByRole('complementary', { name: 'Project explorer' });
const row = (page: Page, name: string) =>
  explorer(page).getByRole('button', { name, exact: true });
const toolbar = (page: Page) => page.locator('.file-toolbar');
const preview = (page: Page) =>
  page.getByRole('dialog', { name: 'Context preview', exact: true });
const chip = (page: Page, label: string) =>
  page.getByRole('button', { name: `Preview context ${label}`, exact: true });
const snapshotLabel = (path = 'hello.txt') => `${path} · editor snapshot`;
const addSelection = (page: Page) =>
  page.getByRole('button', { name: 'Add selection to message', exact: true });

// Wire expectations deliberately do not use the production context builders.
function snapshot(
  path: string,
  body: string,
  dirty = true,
  selection?: { lines: [number, number]; offsets: [number, number] },
) {
  return [
    selection ? 'Frozen editor selection snapshot' : 'Frozen editor snapshot',
    `File: ${JSON.stringify(path)}`,
    ...(selection
      ? [
          `Lines: ${selection.lines[0]}–${selection.lines[1]}`,
          `Editor offsets (UTF-16, end exclusive): ${selection.offsets[0]}–${selection.offsets[1]}`,
        ]
      : []),
    `Unsaved edits at capture: ${dirty ? 'yes' : 'no'}`,
    'This is captured editor text and may include unsaved edits. Capturing it does not save or modify disk. It will not automatically refresh.',
    'Captured text follows verbatim:',
    '',
    body,
  ].join('\n');
}
const block = (label: string, text: string) =>
  `\n\n--- Context: ${label} ---\n${text}`;

async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      (window as any).workflowCalls.filter(
        (call: any) => call.command === command,
      ),
    command,
  );
}

async function flushEvents(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function setup(page: Page, harness: Harness) {
  await concurrentFixture(page);
  if (harness === 'claude') {
    await installClaudeFixture(page);
    await connectClaude(page);
    await page
      .getByRole('combobox', { name: 'Agent', exact: true })
      .selectOption('claude');
  }
  // Before-operation gates fail without touching disk. They also retain exact
  // outgoing agent payloads when a send is rejected before reaching the agent.
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.workflowCalls = [];
    w.workflowPending = [];
    w.workflowHold = '';
    w.workflowStartError = '';
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      w.workflowCalls.push({ command, args });
      if (command === 'agent_start_turn' && w.workflowStartError)
        throw new Error(w.workflowStartError);
      if (command === 'agent_steer_turn' && w.workflowHoldSteerAck) {
        const result = await invoke(command, args);
        return new Promise((resolve) => {
          w.workflowReleaseSteerAck = () => resolve(result);
          w.workflowSteerAckArrived();
        });
      }
      if (command !== w.workflowHold) return invoke(command, args);
      return new Promise((resolve, reject) => {
        w.workflowPending.push({
          reject,
          complete: () => invoke(command, args).then(resolve, reject),
        });
      });
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.workflowClipboard = text;
        },
      },
    });
  });
}

async function start(page: Page, title = 'Integrated workflow owner') {
  await prompt(page).fill(title);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }).first(),
  ).toBeVisible();
  expect(await calls(page, 'agent_start_turn')).toHaveLength(1);
}

async function finish(page: Page, harness: Harness) {
  await page.evaluate((harness) => {
    const w = window as any;
    if (harness === 'claude') w.testClaudeFinish();
    else w.concurrentFinish('concurrent-1');
  }, harness);
  await flushEvents(page);
}

async function showComposer(page: Page) {
  const another = page.getByRole('button', { name: 'Write another message' });
  if (await another.isVisible()) await another.click();
  await expect(prompt(page)).toBeVisible();
}

async function enqueue(page: Page, harness: Harness, text: string) {
  await showComposer(page);
  await prompt(page).fill(text);
  await page
    .getByRole('button', {
      name: harness === 'claude' ? 'Send' : 'Queue for next turn',
      exact: true,
    })
    .click();
  await expect(queue(page)).toBeVisible();
  const expand = queue(page).getByRole('button', { name: /^Show all / });
  if (await expand.isVisible()) await expand.click();
  await showComposer(page);
  await expect(prompt(page)).toHaveValue('');
}

async function openFile(page: Page, path = 'hello.txt') {
  await row(page, path).click();
  await expect(toolbar(page)).toContainText(path);
  await expect(page.locator('.cm-content')).toBeVisible();
}

async function edit(page: Page, text: string) {
  const button = toolbar(page).getByRole('button', {
    name: 'Edit',
    exact: true,
  });
  if (await button.isVisible()) await button.click();
  await page.locator('.cm-content').fill(text);
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
}

async function addSnapshot(page: Page) {
  await page
    .getByRole('button', { name: 'Add file context for current editor' })
    .click();
  const picker = page.getByRole('dialog', {
    name: 'Add file context',
    exact: true,
  });
  await picker
    .getByRole('radio', { name: 'Editor snapshot', exact: true })
    .check();
  await picker
    .getByRole('button', { name: /^(Add|Update) editor snapshot$/ })
    .click();
  await expect(picker).toHaveCount(0);
}

async function expectContext(page: Page, label: string, expected: string) {
  await chip(page, label).click();
  await preview(page).getByRole('button', { name: 'Copy context' }).click();
  expect(await page.evaluate(() => (window as any).workflowClipboard)).toBe(
    expected,
  );
  await preview(page)
    .getByRole('button', { name: 'Close context preview' })
    .click();
}

async function selectRange(page: Page, from: number, to: number) {
  const editor = page.locator('.cm-content');
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await editor.focus();
  await editor.press(mac ? 'Meta+ArrowUp' : 'Control+Home');
  for (let i = 0; i < from; i++) await editor.press('ArrowRight');
  for (let i = from; i < to; i++) await editor.press('Shift+ArrowRight');
  await expect(addSelection(page)).toBeEnabled();
}

async function holdMutation(page: Page, command: 'file_rename' | 'file_trash') {
  await page.evaluate((command) => {
    const w = window as any;
    w.workflowHold = command;
    w.workflowPending = [];
  }, command);
}

async function releaseMutation(page: Page, error = '') {
  await page.evaluate((error) => {
    const w = window as any;
    w.workflowHold = '';
    const [pending] = w.workflowPending;
    if (error) pending.reject(new Error(error));
    else pending.complete();
  }, error);
  await flushEvents(page);
}

async function rename(page: Page, from: string, to: string) {
  await row(page, from).focus();
  await row(page, from).press('F2');
  const field = explorer(page).getByRole('textbox', { name: `Rename ${from}` });
  await field.fill(to);
  await field.press('Enter');
  return field;
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

for (const harness of ['codex', 'claude'] as const) {
  test(`${harness}: reordered paused queues retain frozen sources through refresh, navigation, send failure and retry`, async ({
    page,
  }) => {
    await setup(page, harness);
    await start(page);
    await openFile(page);
    const original = 'alpha original snapshot\nsecond line';
    await edit(page, original);
    await addSnapshot(page);
    await selectRange(page, 0, 5);
    await addSelection(page).click();
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await enqueue(page, harness, 'Original snapshot and selection');
    await edit(page, 'second queued capture');
    await addSnapshot(page);
    await enqueue(page, harness, 'Second captured step');
    await expect(entries(page)).toHaveCount(2);
    await queue(page).getByRole('button', { name: 'Pause queue' }).click();
    await entries(page).nth(1).getByRole('button', { name: 'Move up' }).click();
    await expect(entries(page).first()).toContainText('Second captured step');
    await edit(page, 'initial composer capture');
    await addSnapshot(page);
    await edit(page, 'explicitly refreshed composer capture');
    await chip(page, snapshotLabel()).click();
    await preview(page)
      .getByRole('button', { name: 'Update from editor' })
      .click();
    await expect(preview(page).locator('pre')).toHaveText(
      snapshot('hello.txt', 'explicitly refreshed composer capture'),
    );
    await page.keyboard.press('Escape');
    await prompt(page).fill('Keep the owner draft');
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await finish(page, harness);
    expect(await calls(page, 'agent_start_turn')).toHaveLength(1);
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await prompt(page).fill('Independent new conversation draft');
    await openFile(page);
    await edit(page, 'Independent new conversation frozen source');
    await addSnapshot(page);
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await switchTask(
      page,
      harness === 'claude'
        ? 'Claude terminal conversation'
        : 'Integrated workflow owner',
    );
    await expect(prompt(page)).toHaveValue('Keep the owner draft');
    await expectContext(
      page,
      snapshotLabel(),
      snapshot('hello.txt', 'explicitly refreshed composer capture'),
    );
    await expect(
      page.getByRole('button', { name: 'Remove attachment brief.md' }),
    ).toBeVisible();
    const expand = queue(page).getByRole('button', { name: /^Show all / });
    if (await expand.isVisible()) await expand.click();
    await expect(entries(page).first()).toContainText('Second captured step');
    await page.evaluate(() => {
      (window as any).workflowStartError = 'Queued context send rejected';
    });
    await queue(page).getByRole('button', { name: 'Resume queue' }).click();
    await expect(queue(page).getByRole('alert')).toContainText(
      'Queued context send rejected',
    );
    await expect(entries(page)).toHaveCount(2);
    await expect(prompt(page)).toHaveValue('Keep the owner draft');
    const failed = (await calls(page, 'agent_start_turn'))[1];
    expect(failed.args.prompt).toBe(
      'Second captured step' +
        block(snapshotLabel(), snapshot('hello.txt', 'second queued capture')),
    );
    await openFile(page);
    await edit(
      page,
      'latest editor buffer must not leak into either queue entry',
    );
    await page.evaluate(() => ((window as any).workflowStartError = ''));
    await queue(page)
      .getByRole('button', { name: 'Send now', exact: true })
      .click();
    await expect(entries(page)).toHaveCount(1);
    const retried = (await calls(page, 'agent_start_turn'))[2];
    expect(retried.args).toEqual(failed.args);
    await finish(page, harness);
    expect(await calls(page, 'agent_start_turn')).toHaveLength(3);
    await expect(queue(page)).toContainText('Original snapshot and selection');
    await queue(page).getByRole('button', { name: 'Resume queue' }).click();
    await expect(queue(page)).toHaveCount(0);
    const sent = await calls(page, 'agent_start_turn');
    expect(sent).toHaveLength(4);
    expect(sent[3].args.harness).toBe(harness);
    expect(sent[3].args.prompt).toBe(
      'Original snapshot and selection' +
        block(snapshotLabel(), snapshot('hello.txt', original)) +
        block(
          'hello.txt · lines 1–1',
          snapshot('hello.txt', 'alpha', true, {
            lines: [1, 1],
            offsets: [0, 5],
          }),
        ),
    );
    expect(sent[3].args.attachmentIds).toEqual(['brief', 'screen']);
    await expect(prompt(page)).toHaveValue('Keep the owner draft');
    await expectContext(
      page,
      snapshotLabel(),
      snapshot('hello.txt', 'explicitly refreshed composer capture'),
    );
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await expect(prompt(page)).toHaveValue(
      'Independent new conversation draft',
    );
    await expectContext(
      page,
      snapshotLabel(),
      snapshot('hello.txt', 'Independent new conversation frozen source'),
    );
    await expect(
      page.getByRole('button', { name: 'Remove attachment brief.md' }),
    ).toBeVisible();
    expect(await calls(page, 'file_save')).toHaveLength(0);
    expect(await calls(page, 'agent_steer_turn')).toHaveLength(0);
    expect(await calls(page, 'agent_interrupt_turn')).toHaveLength(0);
  });

  test(`${harness}: conflict comparison and confirmed reload cannot replace queued or unsent context`, async ({
    page,
  }) => {
    await setup(page, harness);
    await start(page);
    await openFile(page);
    const captured = 'Unsaved work captured before the disk conflict';
    await edit(page, captured);
    await addSnapshot(page);
    await enqueue(page, harness, 'Explain the pre-conflict capture');
    await edit(page, 'Current unsaved editor and composer capture');
    await addSnapshot(page);
    await prompt(page).fill(
      'Keep this separate draft during conflict resolution',
    );
    await page.evaluate(() =>
      (window as any).testDiskChange('hello.txt', 'The replacement on disk'),
    );
    await toolbar(page).getByRole('button', { name: /^Save/ }).click();
    const banner = page.locator('.file-conflict-banner');
    await expect(banner).toContainText('CONFLICT');
    await banner.getByRole('button', { name: 'Compare', exact: true }).click();
    const comparison = page.getByRole('region', {
      name: 'File conflict comparison',
      exact: true,
    });
    await expect(comparison.locator('pre').nth(0)).toHaveText(
      'Current unsaved editor and composer capture',
    );
    await expect(comparison.locator('pre').nth(1)).toHaveText(
      'The replacement on disk',
    );
    await comparison
      .getByRole('button', { name: 'Reload disk', exact: true })
      .click();
    const confirmation = page.getByRole('dialog', {
      name: 'Reload disk version?',
    });
    await confirmation
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(comparison.locator('pre').nth(0)).toHaveText(
      'Current unsaved editor and composer capture',
    );
    await expect(queue(page)).toContainText('Explain the pre-conflict capture');
    await comparison
      .getByRole('button', { name: 'Reload disk', exact: true })
      .click();
    await confirmation
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expect(comparison).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText(
      'The replacement on disk',
    );
    await expect(page.locator('.file-status')).toContainText('Saved on disk');
    await expectContext(
      page,
      snapshotLabel(),
      snapshot('hello.txt', 'Current unsaved editor and composer capture'),
    );
    await finish(page, harness);
    await expect(queue(page)).toHaveCount(0);
    const sent = await calls(page, 'agent_start_turn');
    expect(sent).toHaveLength(2);
    expect(sent[1].args.harness).toBe(harness);
    expect(sent[1].args.prompt).toBe(
      'Explain the pre-conflict capture' +
        block(snapshotLabel(), snapshot('hello.txt', captured)),
    );
    await expect(prompt(page)).toHaveValue(
      'Keep this separate draft during conflict resolution',
    );
    await chip(page, snapshotLabel()).click();
    await preview(page)
      .getByRole('button', { name: 'Update from editor' })
      .click();
    await expect(preview(page).locator('pre')).toHaveText(
      snapshot('hello.txt', 'The replacement on disk', false),
    );
    await page.keyboard.press('Escape');
    const saves = await calls(page, 'file_save');
    expect(saves).toHaveLength(1);
    expect(saves[0].args.content).toBe(
      'Current unsaved editor and composer capture',
    );
    expect(saves[0].args.expectedFingerprint.hash).toBe('before\n');
  });

  test(`${harness}: a held in-place rename preserves selection and undo while old queued snapshots retain their path`, async ({
    page,
  }) => {
    await setup(page, harness);
    await start(page);
    await openFile(page);
    const saved = 'alpha beta gamma';
    await edit(page, saved);
    await toolbar(page).getByRole('button', { name: /^Save/ }).click();
    await expect(page.locator('.file-status')).toContainText('Saved on disk');
    await addSnapshot(page);
    await enqueue(page, harness, 'Review the original filename snapshot');
    await selectRange(page, 6, 10);
    await holdMutation(page, 'file_rename');
    const field = await rename(page, 'hello.txt', 'renamed.txt');
    await expect(field).toBeDisabled();
    await expect(addSelection(page)).toBeDisabled();
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await addSelection(page).evaluate((button: HTMLButtonElement) =>
      button.click(),
    );
    await expect(chip(page, 'hello.txt · lines 1–1')).toHaveCount(0);
    await prompt(page).fill(
      'Draft typed while the filename operation is pending',
    );
    await releaseMutation(page);
    await expect(row(page, 'renamed.txt')).toBeVisible();
    await expect(toolbar(page)).toContainText('renamed.txt');
    await expect(addSelection(page)).toBeEnabled();
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'true',
    );
    // Do not focus, click, or reselect in CodeMirror after the rename. Add must
    // use the preserved range with its live path and saved-state provenance.
    await addSelection(page).click();
    const selected = snapshot('renamed.txt', 'beta', false, {
      lines: [1, 1],
      offsets: [6, 10],
    });
    await expectContext(page, 'renamed.txt · lines 1–1', selected);
    await expect(chip(page, 'hello.txt · lines 1–1')).toHaveCount(0);
    await page.locator('.cm-content').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.cm-content')).toContainText('before');
    await expect(page.locator('.cm-content')).not.toContainText(saved);
    await expect(page.locator('.file-status')).toContainText('Unsaved changes');
    await expect(toolbar(page)).toContainText('renamed.txt');
    await finish(page, harness);
    await expect(queue(page)).toHaveCount(0);
    const sent = await calls(page, 'agent_start_turn');
    expect(sent).toHaveLength(2);
    expect(sent[1].args.prompt).toBe(
      'Review the original filename snapshot' +
        block(snapshotLabel(), snapshot('hello.txt', saved, false)),
    );
    expect(sent[1].args.prompt).not.toContain('renamed.txt');
    await expectContext(page, 'renamed.txt · lines 1–1', selected);
    await expect(prompt(page)).toHaveValue(
      'Draft typed while the filename operation is pending',
    );
    expect(await calls(page, 'file_save')).toHaveLength(1);
    expect(
      (await calls(page, 'file_rename')).map((call: any) => call.args),
    ).toEqual([
      {
        expectedProjectRoot: root,
        relativePath: 'hello.txt',
        name: 'renamed.txt',
      },
    ]);
  });

  test(`${harness}: snapshot-only current and stashed drafts protect project selection and require an explicit exit decision`, async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.testRecentProjects = ['/work/next-project'];
      w.testOtherWindows = { count: 1, projects: ['/work/unrelated-project'] };
    });
    await setup(page, harness);
    await start(page);
    await finish(page, harness);
    await expect(
      page.getByRole('button', { name: 'Stop', exact: true }),
    ).toHaveCount(0);
    await openFile(page);
    await addSnapshot(page);
    await expect(prompt(page)).toHaveValue('');
    await expect(
      page.getByRole('button', { name: /^Remove attachment / }),
    ).toHaveCount(0);
    const warning = page.getByRole('dialog', {
      name: 'Unsent drafts will be discarded',
    });
    await page.evaluate(() =>
      (window as any).testEmitApp('tauri://close-requested'),
    );
    await expect(warning).toContainText('1 unsent draft will be discarded');
    await expect(warning).toContainText('including captured context');
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expectContext(
      page,
      snapshotLabel(),
      snapshot('hello.txt', 'before\n', false),
    );
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await expect(prompt(page)).toHaveValue('');
    await expect(chip(page, snapshotLabel())).toHaveCount(0);
    await page.locator('.project-button').click();
    const picker = page.getByRole('dialog', { name: 'Switch project' });
    await picker.getByRole('option', { name: /\/work\/next-project/ }).click();
    await expect(picker).toHaveCount(0);
    await flushEvents(page);
    expect(
      (await calls(page, 'window_open')).map((call: any) => call.args.path),
    ).toEqual(['/work/next-project']);
    expect(await calls(page, 'project_open')).toHaveLength(0);
    await expect(page.locator('.project-root')).toHaveAttribute('title', root);
    await page.evaluate(() =>
      (window as any).testEmitApp('tauri://close-requested'),
    );
    await expect(warning).toContainText('1 unsent draft will be discarded');
    await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await calls(page, 'window_close')).toHaveLength(0);
    await switchTask(
      page,
      harness === 'claude'
        ? 'Claude terminal conversation'
        : 'Integrated workflow owner',
    );
    await expect(prompt(page)).toHaveValue('');
    await expectContext(
      page,
      snapshotLabel(),
      snapshot('hello.txt', 'before\n', false),
    );
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.evaluate(() =>
      (window as any).testEmitApp('tauri://close-requested'),
    );
    await warning
      .getByRole('button', { name: 'Discard drafts and leave', exact: true })
      .click();
    await expect(warning).toHaveCount(0);
    await flushEvents(page);
    expect(await calls(page, 'window_close')).toHaveLength(1);
    expect(await calls(page, 'agent_start_turn')).toHaveLength(1);
    expect(await calls(page, 'file_save')).toHaveLength(0);
  });

  for (const action of ['rename', 'trash'] as const) {
    test(`${harness}: a pending ${action} failure keeps queued sources and a growing unrelated editor draft`, async ({
      page,
    }) => {
      await setup(page, harness);
      await start(page);
      await openFile(page);
      await addSnapshot(page);
      await enqueue(
        page,
        harness,
        'Keep the captured file after mutation failure',
      );
      await openFile(page, 'README.md');
      await edit(page, 'Unrelated unsaved file work');
      await addSnapshot(page);
      await page.getByRole('button', { name: 'Attach', exact: true }).click();
      await prompt(page).fill('Unsent message before mutation');
      await holdMutation(
        page,
        action === 'rename' ? 'file_rename' : 'file_trash',
      );
      if (action === 'rename') {
        const field = await rename(page, 'hello.txt', 'failed.txt');
        await expect(field).toBeDisabled();
      } else {
        await row(page, 'hello.txt').click({ button: 'right' });
        await page
          .getByRole('menu', { name: 'Actions for hello.txt' })
          .getByRole('menuitem', { name: /^Move to Trash/ })
          .click();
        await page
          .getByRole('dialog', { name: 'Move ‘hello.txt’ to the Trash?' })
          .getByRole('button', { name: 'Move to Trash', exact: true })
          .click();
      }
      await expect(
        explorer(page).getByRole('button', { name: 'New file', exact: true }),
      ).toBeDisabled();
      await page
        .locator('.cm-content')
        .fill('Unrelated work continued during the file operation');
      await prompt(page).fill(
        'Message continued while native mutation is pending',
      );
      await expect(queue(page)).toContainText(
        'Keep the captured file after mutation failure',
      );
      await releaseMutation(page, `The ${action} could not finish`);
      await expect(explorer(page).getByRole('alert')).toContainText(
        `The ${action} could not finish`,
      );
      if (action === 'rename') {
        const retry = explorer(page).getByRole('textbox', {
          name: 'Rename hello.txt',
        });
        await expect(retry).toBeEnabled();
        await expect(retry).toHaveValue('failed.txt');
        await retry.press('Escape');
        await expect(retry).toHaveCount(0);
      }
      await expect(row(page, 'hello.txt')).toBeVisible();
      await expect(toolbar(page)).toContainText('README.md');
      await expect(page.locator('.cm-content')).toContainText(
        'Unrelated work continued during the file operation',
      );
      await expect(page.locator('.file-status')).toContainText(
        'Unsaved changes',
      );
      await finish(page, harness);
      await expect(queue(page)).toHaveCount(0);
      const sent = await calls(page, 'agent_start_turn');
      expect(sent).toHaveLength(2);
      expect(sent[1].args.prompt).toBe(
        'Keep the captured file after mutation failure' +
          block(snapshotLabel(), snapshot('hello.txt', 'before\n', false)),
      );
      await expect(prompt(page)).toHaveValue(
        'Message continued while native mutation is pending',
      );
      await expectContext(
        page,
        snapshotLabel('README.md'),
        snapshot('README.md', 'Unrelated unsaved file work'),
      );
      await expect(
        page.getByRole('button', { name: 'Remove attachment brief.md' }),
      ).toBeVisible();
      expect(await calls(page, `file_${action}`)).toHaveLength(1);
      expect(await calls(page, 'file_save')).toHaveLength(0);
    });
  }

  test(`${harness}: exact byte caps reject overflow before a frozen queue dispatches in the background`, async ({
    page,
  }) => {
    await setup(page, harness);
    const paths = ['one.txt', 'two.txt'];
    const message = 'Use both complete bounded snapshots';
    const wireOverhead = new TextEncoder().encode(
      message + paths.map((path) => block(snapshotLabel(path), '')).join(''),
    ).length;
    const bodies = paths.map((path, index) =>
      String(index + 1).repeat(
        64 * 1024 -
          new TextEncoder().encode(snapshot(path, '', false)).length -
          (index === 1 ? wireOverhead : 0),
      ),
    );
    await page.evaluate(
      (files) => {
        for (const [path, body] of Object.entries(files))
          (window as any).testDiskChange(path, body);
      },
      Object.fromEntries(paths.map((path, index) => [path, bodies[index]])),
    );
    // Refresh the visible tree after adding fixture files, exactly as an
    // explicit user refresh would discover files written by an agent.
    await explorer(page)
      .getByRole('button', { name: 'Refresh file tree', exact: true })
      .click();
    await start(page);
    for (const path of paths) {
      await openFile(page, path);
      await addSnapshot(page);
    }
    const expected = paths.map((path, index) =>
      snapshot(path, bodies[index], false),
    );
    expect(
      expected.map((text) => new TextEncoder().encode(text).length),
    ).toEqual([64 * 1024, 64 * 1024 - wireOverhead]);
    const fullMessage =
      message +
      paths
        .map((path, index) => block(snapshotLabel(path), expected[index]))
        .join('');
    expect(new TextEncoder().encode(fullMessage).length).toBe(128 * 1024);
    await openFile(page);
    await edit(
      page,
      'Aggregate overflow must not silently remove the other two sources',
    );
    await page
      .getByRole('button', { name: 'Add file context for current editor' })
      .click();
    const picker = page.getByRole('dialog', {
      name: 'Add file context',
      exact: true,
    });
    await picker
      .getByRole('button', { name: 'Add editor snapshot', exact: true })
      .click();
    await expect(picker.getByRole('alert')).toContainText('128 KiB');
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^Preview context / }),
    ).toHaveCount(2);
    await openFile(page, 'one.txt');
    await edit(page, bodies[0] + 'overflow');
    await chip(page, snapshotLabel('one.txt')).click();
    await preview(page)
      .getByRole('button', { name: 'Update from editor' })
      .click();
    await expect(preview(page).getByRole('alert')).toContainText('64 KiB');
    await expect(preview(page).locator('.context-provenance')).toContainText(
      root,
    );
    await page.keyboard.press('Escape');
    await expectContext(page, snapshotLabel('one.txt'), expected[0]);
    await expectContext(page, snapshotLabel('two.txt'), expected[1]);
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await prompt(page).fill(message + 'x');
    await page
      .getByRole('button', {
        name: harness === 'claude' ? 'Send' : 'Queue for next turn',
        exact: true,
      })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      '128 KiB including typed text and attached context',
    );
    await expect(prompt(page)).toHaveValue(message + 'x');
    await expect(queue(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Remove attachment brief.md' }),
    ).toBeVisible();
    await expectContext(page, snapshotLabel('one.txt'), expected[0]);
    await expectContext(page, snapshotLabel('two.txt'), expected[1]);
    expect(await calls(page, 'agent_start_turn')).toHaveLength(1);
    expect(await calls(page, 'agent_steer_turn')).toHaveLength(0);
    await enqueue(page, harness, message);
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await openFile(page);
    await edit(page, 'Foreground source after the capped queue was captured');
    await addSnapshot(page);
    await prompt(page).fill('Keep the foreground draft and its source');
    await finish(page, harness);
    await flushEvents(page);
    const sent = await calls(page, 'agent_start_turn');
    expect(sent).toHaveLength(2);
    expect(sent[1].args.harness).toBe(harness);
    expect(sent[1].args.threadId).toMatch(
      harness === 'claude' ? /^claude:/ : /(?:codex:)?concurrent-1$/,
    );
    expect(sent[1].args.prompt).toBe(fullMessage);
    expect(sent[1].args.attachmentIds).toEqual(['brief', 'screen']);
    await expect(prompt(page)).toHaveValue(
      'Keep the foreground draft and its source',
    );
    await expectContext(
      page,
      snapshotLabel(),
      snapshot(
        'hello.txt',
        'Foreground source after the capped queue was captured',
      ),
    );
    await switchTask(
      page,
      harness === 'claude'
        ? 'Claude terminal conversation'
        : 'Integrated workflow owner',
    );
    await expect(queue(page)).toHaveCount(0);
    await expect(prompt(page)).toHaveValue('');
    expect(await calls(page, 'file_save')).toHaveLength(0);
  });
}

test('Codex completion before a steer acknowledgment keeps its project and newer draft through project selection', async ({
  page,
}) => {
  const destination = '/work/next-project';
  await page.evaluate((destination) => {
    const w = window as any;
    w.testRecentProjects = [destination];
    w.testOtherWindows = { count: 1, projects: ['/work/unrelated-project'] };
  }, destination);
  await setup(page, 'codex');
  await start(page);
  await openFile(page);
  await edit(page, 'Frozen source sent to the running turn');
  await addSnapshot(page);
  await prompt(page).fill('Live frozen correction');
  await page.evaluate(() => {
    const w = window as any;
    w.workflowHoldSteerAck = true;
    w.workflowSteerAckReady = new Promise<void>((resolve) => {
      w.workflowSteerAckArrived = resolve;
    });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => (window as any).workflowSteerAckReady);
  await expect(prompt(page)).toHaveValue('');
  await expect(prompt(page)).toHaveAttribute('readonly', '');
  // Input delivery can already be queued when the send makes the composer
  // readonly. Preserve that newer callback; do not pretend fresh typing works.
  await prompt(page).evaluate((element: HTMLTextAreaElement) => {
    element.value = 'Newer draft delivered before the acknowledgment';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await row(page, 'README.md').click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Add to chat', exact: true })
    .click();
  await expect(chip(page, 'README.md')).toBeVisible();
  await edit(page, 'Newer unsaved editor work after the steer was sent');
  await finish(page, 'codex');
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toHaveCount(0);
  await page.locator('.project-button').click();
  const picker = page.getByRole('dialog', { name: 'Switch project' });
  await picker.getByRole('option', { name: /\/work\/next-project/ }).click();
  await expect(picker).toHaveCount(0);
  await flushEvents(page);
  expect(
    (await calls(page, 'window_open')).map((call: any) => call.args.path),
  ).toEqual([destination]);
  expect(await calls(page, 'project_open')).toHaveLength(0);
  await expect(page.locator('.project-root')).toHaveAttribute('title', root);
  await expect(prompt(page)).toHaveValue(
    'Newer draft delivered before the acknowledgment',
  );
  await expect(chip(page, 'README.md')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText(
    'Newer unsaved editor work after the steer was sent',
  );
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
  await page.evaluate(() => {
    const w = window as any;
    w.workflowHoldSteerAck = false;
    w.workflowReleaseSteerAck();
  });
  await expect(prompt(page)).toBeEditable();
  await expect(prompt(page)).toHaveValue(
    'Newer draft delivered before the acknowledgment',
  );
  await expect(chip(page, 'README.md')).toBeVisible();
  await expect(page.locator('.project-root')).toHaveAttribute('title', root);
  const steers = await calls(page, 'agent_steer_turn');
  expect(steers).toHaveLength(1);
  expect(steers[0].args.prompt).toBe(
    'Live frozen correction' +
      block(
        snapshotLabel(),
        snapshot('hello.txt', 'Frozen source sent to the running turn'),
      ),
  );
  expect(await calls(page, 'agent_start_turn')).toHaveLength(1);
  expect(await calls(page, 'file_save')).toHaveLength(0);
});
