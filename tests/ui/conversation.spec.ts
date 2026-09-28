import { test, expect } from '@playwright/test';
import {
  completePlan,
  concurrentFixture,
  longConversation,
  mockDesktop,
  openProject,
  proposedPlanFixture,
  readingOffset,
  switchTask,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('reload restores navigation but discards unsent new-thread settings', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'src' }).click();
  await page.getByRole('button', { name: 'main.ts' }).click();
  await page.getByRole('button', { name: 'hello.txt' }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('workbench.workspace.v1') ?? '{}')
            .projects?.['/fixture/project']?.activeFile,
      ),
    )
    .toBe('hello.txt');
  await page.reload();
  await expect(
    page.getByText('fixture-project', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'src', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.cm-content')).toContainText('before');
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(calls.some((c: any) => c.command === 'project_pick_directory')).toBe(
    false,
  );
  expect(calls.some((c: any) => c.command === 'codex_start_turn')).toBe(false);
  expect(calls.some((c: any) => c.command === 'codex_get_models')).toBe(false);
});

test('conversation titles come from Codex on reload', async ({ page }) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Initial question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem('fixture-thread-name', 'Codex conversation title'),
  );
  await page.reload();
  await expect(page.locator('.task-header h2')).toHaveText(
    'Codex conversation title',
  );
  await page.evaluate(() =>
    localStorage.setItem('fixture-thread-name', 'Updated by Codex elsewhere'),
  );
  await page.reload();
  await expect(page.locator('.task-header h2')).toHaveText(
    'Updated by Codex elsewhere',
  );
});

test('conversation titles survive follow-ups and stay isolated during live renames and resume', async ({
  page,
}) => {
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Initial request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.task-header h2')).toHaveText('Initial request');
  await page.evaluate(() => {
    const w = window as any;
    w.concurrentThreads['concurrent-1'].name = 'Cancellation improvements';
    w.testEmit('thread-name', {
      threadId: 'concurrent-1',
      name: 'Cancellation improvements',
    });
    w.concurrentFinish('concurrent-1');
  });
  await expect(page.locator('.task-header h2')).toHaveText(
    'Cancellation improvements',
  );
  await prompt.fill('Now add the tests');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.task-header h2')).toHaveText(
    'Cancellation improvements',
  );
  await page.locator('.task-details summary').click();
  await expect(page.locator('.task-original-prompt')).toHaveText(
    'Now add the tests',
  );
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await prompt.fill('Independent second conversation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.concurrentThreads['concurrent-1'].name = 'Subscription retention';
    w.testEmit('thread-name', {
      threadId: 'concurrent-1',
      name: 'Subscription retention',
    });
    const invoke = w.testConcurrentInvoke;
    w.testConcurrentInvoke = (command: string, args: any) => {
      const response = invoke(command, args);
      if (command === 'codex_resume_thread' && args.threadId === 'concurrent-1')
        w.testEmit('thread-name', {
          threadId: 'concurrent-1',
          name: 'Final retention design',
        });
      return response;
    };
  });
  await expect(page.locator('.task-header h2')).toHaveText(
    'Independent second conversation',
  );
  await switchTask(page, 'Subscription retention');
  await expect(page.locator('.task-header h2')).toHaveText(
    'Final retention design',
  );
  await page.evaluate(() =>
    (window as any).testEmit('thread-name', {
      threadId: 'concurrent-1',
      name: null,
    }),
  );
  // Without a Codex title, the opening message names the conversation, not the latest follow-up.
  await expect(page.locator('.task-header h2')).toHaveText('Initial request');
});

test('reload resumes the saved conversation without sending another task', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Initial question');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('workbench.workspace.v1') ?? '{}')
            .projects?.['/fixture/project']?.threadId,
      ),
    )
    .toBe('thread-1');
  await page.reload();
  await expect(page.getByText('Historical result from Codex.')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(calls.some((c: any) => c.command === 'codex_resume_thread')).toBe(
    true,
  );
  expect(calls.some((c: any) => c.command === 'codex_start_turn')).toBe(false);
});

test('chat renders Markdown tables, links, lists and copyable code safely', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(
    () =>
      ((window as any).testReply =
        'I checked current `main`: **13 other blogs contain 17 links**.\n\n| Blog to keep | Links to remove |\n|---|---|\n| [Release notes](https://example.com/release-notes) | YouTube Summarizers |\n| Example blog | Two links |\n\n- Keep existing blogs\n- Remove recommendations\n\n```ts\nconst count = 17;\n```\n\n<script>window.bad = true</script>'),
  );
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Review this cleanup');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.message table')).toBeVisible();
  await expect(
    page
      .locator('.message strong')
      .filter({ hasText: '13 other blogs contain 17 links' }),
  ).toBeVisible();
  await expect(page.locator('.message li')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Copy code', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.message pre code')).toHaveText(
    'const count = 17;\n',
  );
  await expect(page.locator('.message script')).toHaveCount(0);
  await page.getByRole('link', { name: 'Release notes' }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.find(
          (c: any) => c.command === 'open_external',
        )?.args.url,
    ),
  ).toBe('https://example.com/release-notes');
  await page.screenshot({
    path: 'test-results/screenshots/workbench-chat.png',
  });
  await page.evaluate(() =>
    (window as any).testEmit('timeline-item', {
      id: 'local-link',
      threadId: 'thread-1',
      turnId: 'turn-1',
      kind: 'message',
      title: 'Codex',
      status: 'completed',
      text: '[Open source](/fixture/project/src/main.ts:1)',
    }),
  );
  await page.getByRole('link', { name: 'Open source' }).click();
  await expect(page.locator('.cm-content')).toContainText('export const hello');
});

test('Codex questions use selectable cards, custom answers and explicit submission', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Ask questions before planning');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByRole('region', { name: 'Questions from Codex' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next →' })).toBeDisabled();
  await page.getByRole('radio', { name: /Focused change/ }).check();
  await expect(
    page.getByText('Fix the affected page with a small patch.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'codex_respond_server_request',
        ).length,
    ),
  ).toBe(0);
  await page.screenshot({
    path: 'test-results/screenshots/workbench-questions.png',
  });
  await page.getByRole('button', { name: 'Next →' }).click();
  await page
    .getByRole('textbox', { name: 'Your answer' })
    .fill('Preserve existing links outside the deletion list.');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(
    page.getByRole('radio', { name: /Focused change/ }),
  ).toBeChecked();
  await page.getByRole('radio', { name: /Write your own answer/ }).check();
  await page
    .getByRole('textbox', { name: 'Your answer' })
    .fill('Only remove the broken recommendations.');
  await page.getByRole('button', { name: 'Next →' }).click();
  await page
    .getByRole('button', { name: 'Submit answers', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Questions from Codex' }),
  ).toHaveCount(0);
  const responses = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_respond_server_request',
    ),
  );
  expect(responses).toHaveLength(1);
  expect(responses[0].args.answers).toEqual({
    scope: 'Only remove the broken recommendations.',
    details: 'Preserve existing links outside the deletion list.',
  });
});

test('follow-ups preserve earlier messages in the conversation', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('First message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Second message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.locator('.message.user').first()).toContainText(
    'First message',
  );
  await expect(page.locator('.message.user').last()).toContainText(
    'Second message',
  );
  await expect(page.locator('.message .markdown')).toHaveCount(2);
});

test('reload prefers the running thread and reconstructs its pending question', async ({
  page,
}) => {
  await openProject(page);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('workbench.workspace.v1')),
    )
    .not.toBeNull();
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('workbench.workspace.v1')!);
    saved.projects['/fixture/project'].threadId = null;
    localStorage.setItem('workbench.workspace.v1', JSON.stringify(saved));
    localStorage.setItem('fixture-active-restore', 'true');
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Continue this approach?' }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(
    calls.find((c: any) => c.command === 'codex_resume_thread')?.args.threadId,
  ).toBe('thread-1');
  expect(
    calls.some(
      (c: any) =>
        c.command === 'codex_start_turn' ||
        c.command === 'codex_interrupt_turn',
    ),
  ).toBe(false);
});

test('Codex thread settings win over stale workspace values and catalog defaults', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => {
    const w = window as any;
    w.testThreadSettings = {
      model: 'thread-only-model',
      effort: 'high',
      mode: 'plan',
      sandbox: { type: 'readOnly' },
      approvalPolicy: 'never',
    };
    const saved = JSON.parse(
      localStorage.getItem('workbench.workspace.v1') ?? '{}',
    );
    if (saved.projects?.['/fixture/project']) {
      saved.projects['/fixture/project'].mode = 'default';
      localStorage.setItem('workbench.workspace.v1', JSON.stringify(saved));
    }
  });
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: /Fix hello/ }).click();
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Model: thread-only-model/ }).click();
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).toHaveValue('thread-only-model');
  await expect(
    page.getByRole('combobox', { name: 'Reasoning effort' }),
  ).toHaveValue('high');
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Continue');
  await page.getByRole('button', { name: 'Send' }).click();
  const sent = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(sent.args).toMatchObject({ model: null, effort: null, mode: null });
});

test('mode changes update Codex and survive reload without changing historical turn metadata', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Plan the work');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText('Updated hello.txt and ran the tests.'),
  ).toBeVisible();
  await expect(page.locator('.task-meta')).toContainText('Plan mode');
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.task-meta')).toContainText('Plan mode');
  const call = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_update_thread_settings',
    ),
  );
  expect(call.args).toEqual({ threadId: 'thread-1', mode: 'default' });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  const local = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('workbench.workspace.v1') ?? '{}')
        .projects['/fixture/project'],
  );
  expect(local).not.toHaveProperty('mode');
});

test('missing thread values and stale settings events do not invent Code or reuse another model', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => {
    (window as any).testThreadSettings = {
      model: null,
      effort: null,
      mode: null,
      sandbox: null,
      approvalPolicy: null,
    };
  });
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: /Fix hello/ }).click();
  for (const name of ['Plan', 'Code'])
    await expect(
      page.getByRole('button', { name, exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    const w = window as any;
    w.testEmit('connection', { type: 'ready', generation: 5 });
    w.testEmit('thread-settings', {
      threadId: 'thread-1',
      generation: 4,
      settings: { model: 'stale', effort: 'high', mode: 'plan' },
    });
  });
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
});

test('thinking state and streamed summaries end with the Codex turn', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Think about this');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const item = {
      id: 'thinking',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'thinking',
      title: 'Thinking…',
      status: 'inProgress',
      text: '',
    };
    w.testEmit('timeline-item', item);
    w.testEmit('timeline-update', [
      {
        itemId: 'thinking',
        threadId: t.id,
        turnId: t.turn.id,
        kind: 'thinking',
        delta: '**Checking dependencies**',
        summaryIndex: 0,
      },
    ]);
  });
  await expect(
    page.getByRole('button', { name: 'Session status' }),
  ).toContainText('Thinking');
  await expect(page.locator('.thinking-summary strong')).toHaveText(
    'Checking dependencies',
  );
  await page.screenshot({ path: 'test-results/thinking-stream.png' });
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await expect(
    page.getByRole('button', { name: 'Session status' }),
  ).toContainText('Ready');
  await expect(page.locator('.thinking-status')).toHaveCount(0);
  await expect(page.locator('.thinking-summary-heading')).toHaveText(
    'Thinking summary',
  );
  await expect(page.locator('.thinking-summary strong')).toBeVisible();
  await expect(page.locator('.thinking-summary summary')).toHaveCount(0);
});

test('completed activity folds away while failures and running commands remain visible', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Review the work');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    for (let n = 0; n < 5; n++)
      w.testEmit('timeline-item', {
        id: `step-${n}`,
        threadId: t.id,
        turnId: t.turn.id,
        kind: 'command',
        title: 'Command',
        command: `read-file-${n}`,
        status: 'completed',
        exitCode: 0,
        output: `Details for command ${n}`,
      });
    w.testEmit('timeline-item', {
      id: 'failure',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'command',
      title: 'Command',
      command: 'npm test failed',
      status: 'completed',
      exitCode: 1,
      output: 'One assertion failed',
    });
    w.testEmit('timeline-item', {
      id: 'running',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'command',
      title: 'Command',
      command: 'npm run verify',
      status: 'inProgress',
    });
  });
  await expect(
    page.getByRole('button', { name: /5 commands.*Show activity/ }),
  ).toBeVisible();
  const group = page.locator('.activity-group-toggle');
  await expect(group).toContainText('Completed');
  await expect(group.locator('.activity-group-detail')).toHaveText(
    'read-file-4',
  );
  await expect(group.locator('.activity-group-result')).toHaveText('Exit 0');
  await expect(
    page.getByRole('button', { name: /npm test failed/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /npm run verify/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /read-file-0/ })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: /5 commands.*Show activity/ }).click();
  await page.getByRole('button', { name: /read-file-0/ }).click();
  await expect(
    page.getByText('Details for command 0', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /read-file-0/ }),
  ).toBeInViewport();
  await page.getByRole('button', { name: /5 commands.*Hide activity/ }).click();
  await page
    .getByRole('button', { name: 'Enter focus mode', exact: true })
    .click();
  await page.screenshot({
    path: 'test-results/screenshots/activity-focus.png',
    animations: 'disabled',
  });
});

test('chat keeps its reading anchor across files, review, task switches, and background activity', async ({
  page,
}) => {
  await longConversation(page);
  const offset = await readingOffset(page);
  for (const destination of ['Files', 'Changes']) {
    await page
      .getByRole('button', { name: destination, exact: true })
      .first()
      .click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect
      .poll(async () => Math.abs((await readingOffset(page)) - offset))
      .toBeLessThan(3);
  }
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('A separate draft');
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    for (let n = 150; n < 200; n++) {
      const item = {
        id: `read-${n}`,
        threadId: t.id,
        turnId: t.turn.id,
        kind: 'message',
        title: 'Codex',
        status: 'completed',
        text: `Background checkpoint ${n}`,
      };
      t.items.push(item);
      w.testEmit('timeline-item', item);
    }
  });
  await switchTask(page, 'Inspect the request pipeline');
  await expect
    .poll(async () => Math.abs((await readingOffset(page)) - offset))
    .toBeLessThan(3);
  await expect(
    page.getByRole('button', { name: 'Jump to latest ↓' }),
  ).toBeVisible();
  expect(await page.locator('[data-reading-key]').count()).toBeLessThanOrEqual(
    400,
  );
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'A separate draft',
  );
});

test('reading stays steady when earlier content grows and search returns to the same place', async ({
  page,
}) => {
  await longConversation(page);
  const offset = await readingOffset(page);
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const item = t.items.find((i: any) => i.id === 'read-70');
    item.text += '\n\n' + 'More context from Codex.\n\n'.repeat(25);
    w.testEmit('timeline-item', { ...item });
  });
  await expect
    .poll(async () => Math.abs((await readingOffset(page)) - offset))
    .toBeLessThan(3);
  await page.keyboard.press('Meta+f');
  const search = page.getByRole('textbox', { name: 'Find in timeline' });
  await expect(search).toBeFocused();
  await search.fill('Matching needle');
  await expect(page.locator('.conversation-navigation')).toContainText(
    '2 matches',
  );
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(page.locator('.conversation-navigation')).toContainText(
    '2 of 2',
  );
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await readingOffset(page)) - offset))
    .toBeLessThan(3);
  await expect(
    page.getByText('Checkpoint 149', { exact: false }),
  ).toBeAttached();
});

test('expanded activity survives navigation and sending a follow-up resumes live following', async ({
  page,
}) => {
  await longConversation(page);
  const activity = page.getByRole('button', { name: /npm run check/ });
  await activity.click();
  await expect(activity).toHaveAttribute('aria-expanded', 'true');
  await page
    .getByRole('button', { name: 'Files', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(activity).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.activity-detail')).toContainText(
    'No errors found',
  );
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Continue with the next part');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Jump to latest ↓' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('combobox', { name: 'Jump to message' }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Jump to message' })
    .selectOption({ index: 1 });
  await expect(
    page.getByRole('button', { name: 'Jump to latest ↓' }),
  ).toBeVisible();
});

test('Codex final answers are distinct and can be read from the start without interrupting readers', async ({
  page,
}) => {
  await longConversation(page);
  const offset = await readingOffset(page);
  await expect(page.locator('.final-answer')).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const item = {
      id: 'result',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'message',
      title: 'Codex',
      phase: 'final_answer',
      status: 'completed',
      text:
        '## Request pipeline review\n\nThe findings and changes are ready to inspect.\n\n' +
        Array.from(
          { length: 16 },
          (_, n) =>
            `### Finding ${n + 1}\n\nVerified this path against the observed behavior.\n`,
        ).join('\n'),
    };
    t.items.push(item);
    w.testEmit('timeline-item', item);
    t.turn.status = 'completed';
    w.testEmit('turn-completed', { threadId: t.id, turn: t.turn });
  });
  await expect
    .poll(async () => Math.abs((await readingOffset(page)) - offset))
    .toBeLessThan(3);
  await expect(page.locator('.final-answer .message-label')).toContainText(
    'Answer',
  );
  await page
    .getByRole('button', { name: 'Read answer ↑', exact: true })
    .click();
  await expect
    .poll(async () => Math.abs((await readingOffset(page, ':result')) - 12))
    .toBeLessThan(3);
  await expect(
    page.getByRole('heading', { name: 'Request pipeline review' }),
  ).toBeInViewport();
  await page.screenshot({
    path: 'test-results/screenshots/conversation-answer.png',
    animations: 'disabled',
  });
});

test('empty Codex reasoning shows live status without empty summary disclosures', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Inspect a small change');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    for (let n = 0; n < 8; n++)
      w.testEmit('timeline-item', {
        id: `reasoning-${n}`,
        threadId: t.id,
        turnId: t.turn.id,
        kind: 'thinking',
        title: 'Thinking summary',
        status: 'completed',
        text: '',
      });
    w.testEmit('timeline-item', {
      id: 'reasoning-live',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'thinking',
      title: 'Thinking…',
      status: 'inProgress',
      text: '',
    });
  });
  await expect(
    page.getByRole('button', { name: 'Session status' }),
  ).toContainText('Thinking');
  await expect(page.locator('.thinking-status')).toContainText('Thinking…');
  await expect(page.locator('.thinking-summary')).toHaveCount(0);
  await expect(page.getByText('Waiting for a summary from Codex…')).toHaveCount(
    0,
  );
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await expect(page.locator('.thinking-status')).toHaveCount(0);
  await expect(page.locator('.thinking-summary')).toHaveCount(0);
  await expect(
    page.getByText('Answer for Inspect a small change'),
  ).toBeVisible();
});

test('composer and question actions remain reachable at laptop widths with attachments and long drafts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openProject(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Ask questions before planning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await prompt.fill(
    Array.from({ length: 12 }, (_, i) => `Follow-up instruction ${i}`).join(
      '\n',
    ),
  );
  const questions = page.getByRole('region', { name: 'Questions from Codex' });
  await questions.getByRole('radio', { name: /Focused change/ }).check();
  await questions.getByRole('button', { name: 'Next →' }).click();
  await questions
    .getByRole('textbox', { name: 'Your answer' })
    .fill('Preserve the public interface.');
  const composer = page.locator('.composer-area');
  await expect(composer).toContainText('Image ·');
  await expect(composer).toContainText('File ·');
  const send = page.getByRole('button', {
    name: 'Queue for next turn',
    exact: true,
  });
  await send.scrollIntoViewIfNeeded();
  for (const width of [1000, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await page.evaluate(() => {
      const main = document.querySelector('main')!.getBoundingClientRect();
      const composer = document
        .querySelector('.composer-area')!
        .getBoundingClientRect();
      const send = document
        .querySelector('.send-button')!
        .getBoundingClientRect();
      const stop = document.querySelector('.stop')!.getBoundingClientRect();
      const decision = document
        .querySelector('.question-footer button:last-child')!
        .getBoundingClientRect();
      const decisions = document
        .querySelector('.approvals')!
        .getBoundingClientRect();
      return {
        left: composer.left - main.left,
        right: main.right - composer.right,
        bottom: send.bottom,
        stopBottom: stop.bottom,
        sendHit: document
          .elementFromPoint(
            send.left + send.width / 2,
            send.top + send.height / 2,
          )
          ?.closest('button')
          ?.classList.contains('send-button'),
        transcriptBottom: document
          .querySelector('.timeline')!
          .getBoundingClientRect().bottom,
        statusTop: document
          .querySelector('.thinking-status')!
          .getBoundingClientRect().top,
        composerTop: composer.top,
        decisionBottom: decision.bottom,
        decisionsBottom: decisions.bottom,
        decisionsTop: decisions.top,
        decisionHit: document
          .elementFromPoint(
            decision.left + decision.width / 2,
            decision.top + decision.height / 2,
          )
          ?.closest('button')
          ?.textContent?.includes('Submit answers'),
        sendRight: send.right,
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(800);
    expect(bounds.stopBottom).toBeLessThanOrEqual(800);
    expect(bounds.sendRight).toBeLessThanOrEqual(bounds.width);
    expect(bounds.overflow).toBe(false);
    expect(bounds.sendHit).toBe(true);
    expect(bounds.decisionHit).toBe(true);
    expect(bounds.decisionBottom).toBeLessThanOrEqual(
      bounds.decisionsBottom + 1,
    );
    expect(bounds.transcriptBottom).toBeLessThanOrEqual(bounds.statusTop + 1);
    expect(bounds.statusTop).toBeLessThan(bounds.composerTop);
    // The question sits directly above the composer, below the transcript.
    expect(bounds.transcriptBottom).toBeLessThanOrEqual(
      bounds.decisionsTop + 1,
    );
    expect(bounds.decisionsBottom).toBeLessThanOrEqual(bounds.composerTop + 1);
    await page.screenshot({
      path: `test-results/screenshots/composer-question-${width}.png`,
      animations: 'disabled',
    });
  }
  await page.screenshot({
    path: 'test-results/screenshots/composer-context.png',
    animations: 'disabled',
  });
  await questions
    .getByRole('button', { name: 'Submit answers', exact: true })
    .click();
  await expect(questions).toHaveCount(0);
  await expect(prompt).toHaveValue(/Follow-up instruction 11/);
});

test('proposed plans are distinct from progress and implementation is an explicit prepared reply', async ({
  page,
}) => {
  await proposedPlanFixture(page);
  const plan = page.getByRole('article', {
    name: 'Proposed plan',
    exact: true,
  });
  await expect(
    plan.getByRole('heading', { name: 'Streaming proposal' }),
  ).toBeVisible();
  await expect(
    plan.getByRole('button', { name: 'Prepare implementation' }),
  ).toHaveCount(0);
  const progress = page.getByRole('region', {
    name: 'Task progress',
    exact: true,
  });
  await expect(progress).toContainText('1 of 2 steps reported complete');
  await expect(progress).toContainText('In progress');
  await expect(
    progress.getByRole('button', { name: 'Prepare implementation' }),
  ).toHaveCount(0);
  await completePlan(page);
  await expect(page.getByText('◇ Plan ready', { exact: true })).toBeVisible();
  await expect(plan).not.toContainText('Draft approach');
  await expect(plan).not.toContainText('LATE DRAFT');
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Read plan ↑' }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Keep the API compatible.');
  await plan.getByRole('button', { name: 'Prepare implementation' }).click();
  await expect(
    page.getByRole('button', { name: 'Code', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Keep the API compatible.\n\nImplement the attached plan.',
  );
  await expect(
    page.getByRole('button', { name: 'Preview context Proposed plan' }),
  ).toBeVisible();
  let calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(calls).toHaveLength(1);
  await page.screenshot({
    path: 'test-results/screenshots/proposed-plan.png',
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(calls).toHaveLength(2);
  expect(calls[1].args.prompt).toContain('Reuse the existing handler.');
  const modeChange = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) =>
        c.command === 'codex_update_thread_settings' &&
        c.args.mode === 'default',
    ),
  );
  expect(modeChange).toBeTruthy();
});

test('plans restore from thread history and incomplete plans cannot start implementation', async ({
  page,
}) => {
  await proposedPlanFixture(page);
  await completePlan(page);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await switchTask(page, 'Plan the request pipeline');
  const plan = page.getByRole('article', {
    name: 'Proposed plan',
    exact: true,
  });
  await expect(
    plan.getByRole('heading', { name: 'Request pipeline plan' }),
  ).toBeVisible();
  await plan.getByRole('button', { name: 'Revise plan', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Revise the attached plan. My feedback:',
  );
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const item = t.items.find((item: any) => item.kind === 'plan');
    w.testEmit('timeline-item', { ...item, truncated: true });
  });
  await expect(
    plan.getByRole('button', { name: 'Prepare implementation' }),
  ).toHaveCount(0);
  await expect(plan).toContainText('Plan preview is incomplete');
});

test('failed plan handoff preserves mode and draft and never starts a turn', async ({
  page,
}) => {
  await proposedPlanFixture(page);
  await completePlan(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Preserve my feedback');
  await page.evaluate(() => {
    (window as any).testModeChangeFailure = true;
  });
  await page
    .getByRole('button', { name: 'Prepare implementation', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not change Codex mode',
  );
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Preserve my feedback',
  );
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Preview context Proposed plan' }),
  ).toHaveCount(0);
  const calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(calls).toHaveLength(1);
});

test('repeated plan actions replace the prepared instruction and preserve edited feedback', async ({
  page,
}) => {
  await proposedPlanFixture(page);
  await completePlan(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  const implement = page.getByRole('button', {
    name: 'Prepare implementation',
    exact: true,
  });
  const revise = page.getByRole('button', { name: 'Revise plan', exact: true });
  await prompt.fill('Keep the API compatible.');
  await implement.click();
  await implement.click();
  await expect(prompt).toHaveValue(
    'Keep the API compatible.\n\nImplement the attached plan.',
  );
  await revise.click();
  await expect(prompt).toHaveValue(
    'Keep the API compatible.\n\nRevise the attached plan. My feedback:',
  );
  await prompt.fill(
    'Keep the API compatible.\n\nRevise the attached plan. My feedback: use the existing validation.\n\nDo not change exports.',
  );
  await revise.click();
  await revise.click();
  await expect(prompt).toHaveValue(
    'Keep the API compatible.\n\nRevise the attached plan. My feedback: use the existing validation.\n\nDo not change exports.\n\nRevise the attached plan. My feedback:',
  );
  await expect(
    page.getByRole('button', { name: 'Preview context Proposed plan' }),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.filter(
        (call: any) => call.command === 'codex_start_turn',
      ),
    ),
  ).toHaveLength(1);
});

test('question choices scroll inside the card without overlapping its footer or chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Discuss the cancellation flow');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    w.testEmit('timeline-item', {
      id: 'message',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'message',
      status: 'completed',
      text: 'Background context remains readable below the question card.\n\n'.repeat(
        12,
      ),
    });
    w.testEmit('approval-requested', {
      requestId: 'long-questions',
      generation: 1,
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'userInput',
      questions: Array.from({ length: 3 }, (_, i) => ({
        id: `q${i}`,
        header: ['Pause', 'Credit packs', 'Presentation'][i],
        question:
          'What should offering credit packs accomplish in the cancellation flow?',
        options: Array.from({ length: 4 }, (_, n) => ({
          label: `Choice ${n + 1}`,
          description:
            'Keep the existing subscription behavior and explain the available choices clearly. '.repeat(
              3,
            ),
        })),
      })),
    });
  });
  const card = page.getByRole('region', { name: 'Questions from Codex' });
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1000, height: 650 },
    { width: 1440, height: 940 },
  ]) {
    await page.setViewportSize(size);
    await card.getByRole('radio', { name: /Write your own answer/ }).check();
    await card
      .getByRole('textbox', { name: 'Your answer' })
      .fill('Keep my feedback visible and editable.');
    // WebKit delivers matchMedia and ResizeObserver after viewport changes.
    // Check the settled layout, including hit targets, rather than the resize frame.
    await expect(async () => {
      const geometry = await page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        const card = box('.question-card'),
          body = box('.question-body'),
          footer = box('.question-footer'),
          approvals = box('.approvals'),
          timeline = box('.timeline-stage'),
          status = box('.thinking-status'),
          main = box('main');
        const answer = document.querySelector('.custom-answer textarea')!;
        const answerBox = answer.getBoundingClientRect();
        const x = answerBox.x + answerBox.width / 2;
        const y = Math.min(answerBox.bottom - 5, body.bottom - 5);
        const hit = document.elementFromPoint(x, y);
        const button = document.querySelector(
          '.question-footer button:last-child',
        )!;
        const rect = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('.thinking-status')!);
        const content = range.getBoundingClientRect();
        return {
          bodyBottom: body.bottom,
          bodyHeight: body.height,
          footerTop: footer.top,
          footerBottom: footer.bottom,
          cardBottom: card.bottom,
          approvalsBottom: approvals.bottom,
          approvalsTop: approvals.top,
          timelineTop: timeline.top,
          timelineBottom: timeline.bottom,
          hit: hit === answer,
          answerTop: answerBox.top,
          answerBottom: answerBox.bottom,
          hitTag: hit?.tagName,
          footerHit: button.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          ),
          centered: Math.abs(
            (content.left + content.right) / 2 - (main.left + main.right) / 2,
          ),
          statusBottom: status.bottom,
          composerTop: box('.composer-area').top,
          controlsBottom: box('.composer-controls').bottom,
          composerBottom: box('.composer-inner').bottom,
          overflow: document.documentElement.scrollHeight > innerHeight,
        };
      });
      expect(geometry.bodyHeight).toBeGreaterThan(30);
      expect(geometry.bodyBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
      expect(geometry.footerBottom).toBeLessThanOrEqual(
        geometry.cardBottom + 1,
      );
      expect(geometry.cardBottom).toBeLessThanOrEqual(
        geometry.approvalsBottom + 1,
      );
      // Decisions dock between the transcript (and its status) and the composer.
      expect(geometry.timelineBottom).toBeLessThanOrEqual(
        geometry.approvalsTop + 1,
      );
      expect(geometry.statusBottom).toBeLessThanOrEqual(
        geometry.approvalsTop + 1,
      );
      expect(geometry.approvalsBottom).toBeLessThanOrEqual(
        geometry.composerTop + 1,
      );
      expect(geometry.hit, JSON.stringify({ size, geometry })).toBe(true);
      expect(geometry.footerHit).toBe(true);
      expect(geometry.centered).toBeLessThan(4);
      expect(geometry.statusBottom).toBeLessThanOrEqual(
        geometry.composerTop + 1,
      );
      expect(geometry.overflow).toBe(false);
      expect(geometry.controlsBottom).toBeLessThanOrEqual(
        geometry.composerBottom + 1,
      );
    }).toPass({ timeout: 3000 });
    await page.screenshot({
      path: `test-results/screenshots/questions-contained-${size.width}.png`,
      animations: 'disabled',
    });
  }
  await card.getByRole('button', { name: 'Next →' }).click();
  await expect(card.getByRole('heading')).toBeFocused();
  expect(
    await card.locator('.question-body').evaluate((node) => node.scrollTop),
  ).toBe(0);
  await card.getByRole('radio', { name: /Choice 4/ }).check();
  await card.getByRole('button', { name: 'Next →' }).click();
  await card.getByRole('radio', { name: /Choice 2/ }).check();
  await card
    .getByRole('button', { name: 'Submit answers', exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Codex is working…' }),
  ).toBeVisible();
});

test('permission approvals dock directly above the composer', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Change hello with approval');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByRole('button', { name: 'Allow once', exact: true }),
  ).toBeVisible();
  const order = await page.evaluate(() => {
    const top = (s: string) =>
      document.querySelector(s)!.getBoundingClientRect();
    return {
      transcript: top('.timeline-stage').bottom,
      decisions: top('.approvals').top,
      decisionsBottom: top('.approvals').bottom,
      composer: top('.composer-area').top,
      header: top('.task-header').bottom,
    };
  });
  expect(order.decisions).toBeGreaterThanOrEqual(order.transcript - 1);
  expect(order.decisionsBottom).toBeLessThanOrEqual(order.composer + 1);
  expect(order.transcript).toBeGreaterThan(order.header);
});
