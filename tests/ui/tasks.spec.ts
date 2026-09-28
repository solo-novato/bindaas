import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  concurrentFixture,
  mockDesktop,
  openProject,
  switchTask,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('new tasks run concurrently and returning restores Codex settings and the right approvals', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('First task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New task' })).toBeEnabled();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Unsent first draft');
  await page.getByRole('button', { name: 'New task' }).click();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    '',
  );
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Second task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const approval = {
      requestId: 'background-question',
      generation: 1,
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'userInput',
      decisions: [],
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          question: 'First task question?',
          options: [{ label: 'Continue', description: 'Continue first task' }],
        },
      ],
    };
    t.approvals.push(approval);
    w.testEmit('approval-requested', approval);
    w.testEmit('timeline-item', {
      id: 'background-message',
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'message',
      title: 'Codex',
      text: 'Only first thread can see this',
      status: 'completed',
    });
  });
  await expect(page.getByText('Only first thread can see this')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'First task question?' }),
  ).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Other tasks' })
    .getByRole('button', { name: /Needs attention: First task/ })
    .click();
  await expect(
    page.getByRole('heading', { name: 'First task question?' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Unsent first draft',
  );
  await expect(page.locator('.task-meta')).toContainText('model-concurrent-1');
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(
    page.getByRole('navigation', { name: 'Other tasks' }),
  ).toContainText('working');
  await switchTask(page, 'Second task');
  await expect(page.locator('.task-meta')).toContainText('model-concurrent-2');
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }).first(),
  ).toBeVisible();
  const interrupts = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_interrupt_turn',
    ),
  );
  expect(interrupts).toHaveLength(1);
  expect(interrupts[0].args.threadId).toBe('concurrent-1');
  await page.screenshot({ path: 'test-results/concurrent-tasks.png' });
});

test('queued follow-ups stay attached to their background thread', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('First task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Follow up first');
  await page
    .getByRole('button', { name: 'Queue for next turn', exact: true })
    .click();
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Second task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).testCalls.filter(
            (c: any) => c.command === 'codex_start_turn',
          ).length,
      ),
    )
    .toBe(3);
  const calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(calls[2].args).toMatchObject({
    threadId: 'concurrent-1',
    prompt: 'Follow up first',
  });
  await expect(
    page.getByRole('heading', { name: 'Second task', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Answer for First task')).toHaveCount(0);
});

test('launcher searches and opens files with the keyboard without crawling the project', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).focus();
  await page.keyboard.press('Meta+p');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  await expect(launcher).toBeVisible();
  const input = launcher.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('hello');
  await expect(launcher.getByRole('option')).toHaveCount(1);
  await input.press('Enter');
  await expect(launcher).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('before');
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(
    calls
      .filter((c: any) => c.command === 'file_list_directory')
      .map((c: any) => c.args.relativePath),
  ).toEqual(['']);
  expect(
    calls.some(
      (c: any) =>
        c.command === 'codex_get_models' || c.command === 'codex_list_threads',
    ),
  ).toBe(false);
});

test('launcher restores focus, supports arrow selection, and isolates modal shortcuts', async ({
  page,
}) => {
  await openProject(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('An unsent idea');
  await prompt.focus();
  await page.keyboard.press('Meta+k');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  const input = launcher.getByRole('combobox');
  await input.fill('no such action');
  await expect(launcher.getByText('No match yet')).toBeVisible();
  await page.keyboard.press('Meta+3');
  await expect(
    page.getByRole('button', { name: 'Chat', exact: true }),
  ).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('An unsent idea');
  await page.keyboard.press('Meta+k');
  await input.press('ArrowDown');
  await expect(launcher.getByRole('option', { selected: true })).toContainText(
    'Write to Codex',
  );
  await input.press('Enter');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('An unsent idea');
});

test('focus layout preserves panel choices and survives reload', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page
    .getByRole('button', { name: 'Enter focus mode', exact: true })
    .click();
  await expect(page.locator('.project-pane')).toHaveCount(0);
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Leave focus mode', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('workbench.workspace.v1') ?? '{}')
            .projects?.['/fixture/project']?.focusMode,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Leave focus mode', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Meta+Shift+f');
  await expect(page.locator('.project-pane')).toBeVisible();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('A focused task');
  await page.keyboard.press('Meta+Shift+f');
  await page.screenshot({
    path: 'test-results/screenshots/focus-workspace.png',
  });
  await page
    .getByRole('button', { name: 'Jump to anything', exact: true })
    .click();
  await page.screenshot({
    path: 'test-results/screenshots/launcher.png',
    animations: 'disabled',
  });
});

test('launcher can return to a running task without interrupting it', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('First task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Next idea');
  await page.keyboard.press('Meta+k');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  await launcher.getByRole('button', { name: 'Tasks', exact: true }).click();
  await launcher.getByRole('combobox').fill('First task');
  await launcher.getByRole('combobox').press('Enter');
  await expect(
    page.getByRole('heading', { name: 'First task', exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(calls.some((c: any) => c.command === 'codex_interrupt_turn')).toBe(
    false,
  );
  await page.getByRole('button', { name: 'New task' }).click();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Next idea',
  );
});

test('workspace navigation and launcher remain usable at laptop widths', async ({
  page,
}) => {
  await openProject(page);
  for (const width of [1000, 1280, 1440]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(
      page.getByRole('button', { name: 'Jump to anything', exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole('button', { name: 'New task' }),
    ).toBeInViewport();
    const overflow = await page
      .locator('.topbar')
      .evaluate((node) => node.scrollWidth > node.clientWidth);
    expect(overflow).toBe(false);
    await page
      .getByRole('button', { name: 'Jump to anything', exact: true })
      .click();
    const menu = page.getByRole('dialog', { name: 'Jump to anything' });
    await expect(menu).toBeInViewport();
    await expect(menu.getByRole('combobox')).toBeFocused();
    await page.screenshot({
      path: `test-results/screenshots/launcher-${width}.png`,
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
  }
});

test('task switcher stays compact with many tasks and brings attention and drafts back from the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Current task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await prompt.fill('Keep my current draft');
  await page.evaluate(() => {
    const w = window as any;
    for (let n = 0; n < 25; n++) {
      const id = `background-${n}`;
      const t: any = {
        id,
        title: `Background task ${n}`,
        turn: { id: `turn-${n}`, status: 'inProgress' },
        items: [],
        approvals: [],
      };
      w.concurrentThreads[id] = t;
      w.testEmit('turn-started', { threadId: id, turn: t.turn });
      // The resume response supplies the actual title; retain a message for the task header.
      t.items.push({
        id: `user-${n}`,
        threadId: id,
        turnId: t.turn.id,
        kind: 'user',
        title: 'You',
        text: t.title,
        status: 'completed',
      });
    }
    const t = w.concurrentThreads['background-24'];
    const a = {
      requestId: 'attention-24',
      generation: 1,
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'userInput',
      decisions: [],
      questions: [
        {
          id: 'choice',
          header: 'Direction',
          question: 'Which direction should I take?',
          options: [
            {
              label: 'Keep it focused',
              description: 'Apply the requested change.',
            },
          ],
        },
      ],
    };
    t.approvals = [a];
    w.testEmit('approval-requested', a);
  });
  const navigation = page.getByRole('navigation', { name: 'Other tasks' });
  await expect(navigation.getByRole('button')).toHaveCount(2);
  await expect(navigation).toContainText('26');
  const bar = await page.locator('.topbar').boundingBox();
  expect(bar!.height).toBe(48);
  await page.getByRole('button', { name: /Needs attention:/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Which direction should I take?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Browse tasks', exact: true }).click();
  const search = page.getByRole('combobox', {
    name: 'Search actions, tasks, and files',
  });
  await expect(search).toBeFocused();
  await search.fill('Current task');
  await search.press('Enter');
  await expect(prompt).toHaveValue('Keep my current draft');
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: /Needs attention:/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: 'test-results/screenshots/task-switcher-1000.png',
    animations: 'disabled',
  });
});

test('history workspace finds conversations by title and status, paginates explicitly, and preserves drafts', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Keep this unsent draft');
  await page.evaluate(() => {
    const w = window as any,
      now = Math.floor(Date.now() / 1000);
    const row = (
      id: string,
      name: string,
      preview: string,
      runStatus: string,
      age = 0,
    ) => ({
      id,
      name,
      preview,
      runStatus,
      updatedAt: now - age,
      createdAt: now - age,
      status: { type: 'notLoaded' },
      cwd: '/fixture/project',
    });
    w.testRunThreads = [
      row(
        'waiting',
        'Decide retention offers',
        'Clarify the cancellation flow',
        'waitingInput',
      ),
      row(
        'running',
        'Investigate API errors',
        'Check recent server errors',
        'running',
      ),
      row(
        'plan',
        'Subscription pause design',
        'Plan pause and resume behavior',
        'planGenerated',
        86400,
      ),
      row(
        'done',
        'Improve onboarding',
        'Simplify the setup flow',
        'completed',
        864000,
      ),
    ];
    w.testRunNextThreads = [
      row(
        'older',
        'Previous billing investigation',
        'Audit the invoice total',
        'completed',
        1728000,
      ),
    ];
  });
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Project explorer' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: 'Changes inspector' }),
  ).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeHidden();
  await expect(page.locator('.runs-group').first()).toHaveAccessibleName(
    'Needs attention',
  );
  await page.keyboard.press('Meta+f');
  const search = page.getByRole('searchbox', { name: 'Search conversations' });
  await expect(search).toBeFocused();
  await search.fill('PAUSE');
  await expect(page.locator('.runs .thread-row')).toHaveCount(1);
  await expect(page.locator('.runs .thread-row')).toContainText(
    'Subscription pause design',
  );
  const filters = page.getByRole('group', { name: 'Conversation status' });
  await filters.getByRole('button', { name: /Completed/ }).click();
  await expect(
    page.getByRole('heading', { name: 'No matching conversations' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Clear filters', exact: true })
    .click();
  await filters.getByRole('button', { name: /Running/ }).click();
  await expect(page.locator('.runs .thread-row')).toContainText(
    'Investigate API errors',
  );
  await page.evaluate(() =>
    (window as any).testEmit('thread-status', {
      threadId: 'running',
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    }),
  );
  await expect(page.locator('.runs .thread-row')).toHaveCount(0);
  await filters.getByRole('button', { name: /Needs attention/ }).click();
  await expect(page.locator('.runs .thread-row')).toHaveCount(2);
  await filters.getByRole('button', { name: /^All / }).click();
  await search.fill('invoice');
  await expect(
    page.getByRole('heading', { name: 'No matching conversations' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Load older conversations', exact: true })
    .click();
  await expect(page.locator('.runs .thread-row')).toHaveCount(1);
  await expect(page.locator('.runs .thread-row')).toContainText(
    'Previous billing investigation',
  );
  await page.getByRole('button', { name: 'Clear conversation search' }).click();
  for (const size of [
    { width: 1000, height: 650 },
    { width: 1440, height: 940 },
  ]) {
    await page.setViewportSize(size);
    for (const appearance of ['dark', 'light']) {
      await page.evaluate(
        (value) => (document.documentElement.dataset.appearance = value),
        appearance,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/screenshots/history-${appearance}-${size.width}.png`,
        animations: 'disabled',
      });
      if (process.env.WORKBENCH_AXE_PATH) {
        await page.evaluate(
          readFileSync(process.env.WORKBENCH_AXE_PATH, 'utf8'),
        );
        const violations = await page.evaluate(async () => {
          const report = await (window as any).axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          });
          return report.violations.map((v: any) => ({
            id: v.id,
            nodes: v.nodes.map((n: any) => n.target),
          }));
        });
        expect(violations, `${appearance} history at ${size.width}px`).toEqual(
          [],
        );
      }
    }
  }
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(
    calls.filter((call: any) => call.command === 'codex_list_threads'),
  ).toHaveLength(2);
  expect(
    calls.some(
      (call: any) =>
        call.command === 'codex_start_turn' ||
        call.command === 'codex_resume_thread',
    ),
  ).toBe(false);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Keep this unsent draft',
  );
  await expect(
    page.getByRole('complementary', { name: 'Project explorer' }),
  ).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Changes inspector' }),
  ).toBeVisible();
});

test('history failures keep loaded conversations usable and offer an explicit retry', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => ((window as any).testThreadListError = true));
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not load conversation history',
  );
  await expect(
    page.getByRole('heading', { name: 'Your next idea starts here' }),
  ).toHaveCount(0);
  await page.evaluate(() => ((window as any).testThreadListError = false));
  await page.getByRole('button', { name: 'Retry history' }).click();
  await expect(page.locator('.runs .thread-row')).toContainText('Fix hello');
  await page.evaluate(() => ((window as any).testThreadListError = true));
  await page
    .locator('.runs')
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Your loaded conversations are still available.',
  );
  await expect(page.locator('.runs .thread-row')).toBeEnabled();
  await page.locator('.runs .thread-row').click();
  await expect(page.getByText('Historical result from Codex.')).toBeVisible();
});

test('Runs shows reported outcomes and live attention without stale refreshes overwriting events', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => {
    (window as any).testRunThreads = [
      'planGenerated',
      'running',
      'waitingInput',
      'waitingApproval',
      'completed',
      'failed',
      'interrupted',
      'unknown',
    ].map((runStatus, index) => ({
      id: `run-${index}`,
      preview: `Example ${index}`,
      updatedAt: 1,
      createdAt: 1,
      cwd: '/fixture/project',
      status: { type: 'notLoaded' },
      runStatus,
    }));
  });
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  for (const label of [
    'Plan generated',
    'Running',
    'Waiting for input',
    'Waiting for approval',
    'Completed',
    'Failed',
    'Interrupted',
    'Status unavailable',
  ]) {
    await expect(
      page.locator('.runs').getByLabel(`Run status: ${label}`, { exact: true }),
    ).toBeVisible();
  }
  const row = page.locator('.thread-row').filter({ hasText: 'Example 1' });
  await page.evaluate(() =>
    (window as any).testEmit('thread-status', {
      threadId: 'run-0',
      status: { type: 'idle' },
    }),
  );
  await expect(
    page.locator('.thread-row').filter({ hasText: 'Example 0' }),
  ).toContainText('Plan generated');
  await page.evaluate(() => {
    const w = window as any;
    w.testThreadListDelay = 350;
    w.testEmit('turn-started', {
      threadId: 'run-1',
      turn: { id: 'fresh-turn', status: 'inProgress' },
    });
  });
  await page
    .locator('.runs')
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  await page.evaluate(() => {
    const w = window as any;
    w.testEmit('approval-requested', {
      threadId: 'run-1',
      turnId: 'fresh-turn',
      requestId: 'question',
      generation: 1,
      kind: 'userInput',
      questions: [],
    });
  });
  await expect(
    page.locator('.runs').getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await expect(row).toContainText('Waiting for input');
  await page.evaluate(() => {
    const w = window as any;
    w.testEmit('approval-resolved', {
      threadId: 'run-1',
      requestId: 'question',
      waiting: false,
    });
    w.testEmit('timeline-item', {
      id: 'plan',
      threadId: 'run-1',
      turnId: 'fresh-turn',
      kind: 'plan',
      status: 'completed',
      text: 'The proposed plan',
    });
    w.testEmit('turn-completed', {
      threadId: 'run-1',
      turn: { id: 'fresh-turn', status: 'completed' },
    });
  });
  await expect(row).toContainText('Plan generated');
  await page.evaluate(() =>
    (window as any).testEmit('thread-status', {
      threadId: 'run-1',
      status: { type: 'idle' },
    }),
  );
  await expect(row).toContainText('Plan generated');
  await page.screenshot({
    path: 'test-results/screenshots/runs-status.png',
    animations: 'disabled',
  });
});

test('conversation management renames pins archives and restores from Codex history', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Original conversation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.locator('.conversation-row').first().hover();
  // Row actions appear on hover or keyboard focus.
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Conversation title' })
    .fill('Checkout improvements');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(
    page.getByText('Checkout improvements', { exact: true }).first(),
  ).toBeVisible();
  await page.locator('.conversation-row').first().hover();
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Pinned', exact: true }),
  ).toBeVisible();
  const pins = await page.evaluate(
    () =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'settings_save')
        .at(-1).args.value.pinnedThreads,
  );
  expect(pins).toEqual(['concurrent-1']);
  await page.locator('.conversation-row').first().hover();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(
    page.getByText('Checkout improvements', { exact: true }).first(),
  ).toBeVisible();
  await page.locator('.conversation-row').first().hover();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Restore', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Conversations', exact: true })
    .click();
  await expect(
    page.getByText('Checkout improvements', { exact: true }).first(),
  ).toBeVisible();
});

test('background tasks announce completion in-app and open from the notification', async ({
  page,
}) => {
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Background refactor');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await prompt.fill('Foreground question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.task-header h2')).toHaveText(
    'Foreground question',
  );
  await page.evaluate(() => (window as any).concurrentFinish('concurrent-1'));
  const updates = page.getByRole('region', {
    name: 'Background task updates',
  });
  await expect(updates).toContainText('Background refactor');
  await expect(updates).toContainText('Finished in the background');
  await updates.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.task-header h2')).toHaveText(
    'Background refactor',
  );
  await expect(updates.getByRole('status')).toHaveCount(0);
});

test('⌘P finds project files that were never opened through on-demand search', async ({
  page,
}) => {
  await openProject(page);
  await page.keyboard.press('Meta+p');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  await launcher.getByRole('combobox').fill('deeputil');
  await expect(
    launcher.getByRole('option', { name: /util\.ts/ }),
  ).toBeVisible();
  await launcher.getByRole('combobox').press('Enter');
  await expect(page.locator('.file-toolbar')).toContainText(
    'src/lib/deep/util.ts',
  );
  await expect(page.locator('.cm-content')).toContainText('export const util');
});

test('dock badge counts conversations waiting on you and clears', async ({
  page,
}) => {
  await concurrentFixture(page);
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.fill('Background question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await prompt.fill('Foreground work');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const badges = () =>
    page.evaluate(() =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'plugin:window|set_badge_count')
        .map((c: any) => c.args.value ?? null),
    );
  expect(await badges()).toEqual([]);
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    const approval = {
      requestId: 'badge-question',
      generation: 1,
      threadId: t.id,
      turnId: t.turn.id,
      kind: 'userInput',
      decisions: [],
      questions: [
        {
          id: 'q',
          header: 'Q',
          question: 'Proceed?',
          options: [{ label: 'Yes', description: 'Go' }],
        },
      ],
    };
    t.approvals.push(approval);
    w.testEmit('approval-requested', approval);
  });
  await expect.poll(badges).toEqual([1]);
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    t.approvals = [];
    w.testEmit('approval-resolved', {
      threadId: t.id,
      requestId: 'badge-question',
      waiting: false,
    });
  });
  await expect.poll(badges).toEqual([1, null]);
});
