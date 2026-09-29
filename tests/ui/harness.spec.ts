import { test, expect } from '@playwright/test';
import {
  connectClaude,
  installClaudeFixture,
  mockDesktop,
  openProject,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('harness opt-in keeps Codex default and switching isolates drafts without sending', async ({
  page,
}) => {
  await openProject(page);
  await expect(
    page.getByRole('combobox', { name: 'Agent', exact: true }),
  ).toHaveCount(0);
  await installClaudeFixture(page);
  await connectClaude(page);
  const picker = page.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(picker).toHaveValue('codex');
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Codex unsent draft');
  await picker.selectOption('claude');
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    '',
  );
  await expect(
    page.getByText('New Claude conversation.', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Claude unsent draft');
  await picker.selectOption('codex');
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Codex unsent draft',
  );
  await picker.selectOption('claude');
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    'Claude unsent draft',
  );
  expect(
    await page.evaluate(() =>
      (window as any).testAgentCalls.filter(
        (c: any) => c.command === 'agent_start_turn',
      ),
    ),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Native Claude permissions' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Apply permissions' }),
  ).toHaveCount(0);
});

test('harness sessions survive unrelated disconnects and Claude follow-ups queue instead of steering', async ({
  page,
}) => {
  await openProject(page);
  await installClaudeFixture(page);
  await connectClaude(page);
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption('claude');
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Claude first task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: false }),
  ).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as any).testAgentCalls.filter(
      (c: any) => c.command === 'agent_start_turn',
    ),
  );
  expect(calls[0].args).toMatchObject({
    harness: 'claude',
    permissions: null,
    approvalPolicy: null,
  });
  await page.evaluate(() =>
    (window as any).testEmit('connection', {
      harness: 'codex',
      generation: 99,
      type: 'disconnected',
    }),
  );
  await expect(page.getByText('In progress', { exact: true })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Claude queued follow-up');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Queued message' }),
  ).toContainText('Claude queued follow-up');
  expect(
    await page.evaluate(() =>
      (window as any).testAgentCalls.filter(
        (c: any) => c.command === 'agent_steer_turn',
      ),
    ),
  ).toHaveLength(0);
  await page.evaluate(() => (window as any).testClaudeQuestion());
  const card = page.getByRole('region', { name: 'Questions from Claude' });
  await expect(card).toBeVisible();
  await card.getByRole('checkbox').nth(0).check();
  await card.getByRole('checkbox').nth(1).check();
  await card.getByRole('button', { name: 'Submit answers' }).click();
  const response = await page.evaluate(() =>
    (window as any).testAgentCalls.find(
      (c: any) => c.command === 'agent_respond_server_request',
    ),
  );
  expect(response.args).toMatchObject({
    generation: 1,
    threadId: 'claude:11111111-1111-4111-8111-111111111111',
    answers: { '0': ['Unit', 'Integration'] },
  });
  await page.evaluate(() => (window as any).testClaudeFinish());
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as any).testAgentCalls.filter(
            (c: any) => c.command === 'agent_start_turn',
          ).length,
      ),
    )
    .toBe(2);
});

test('harness native history is labeled, filterable, and resumes with native permissions', async ({
  page,
}) => {
  await openProject(page);
  await installClaudeFixture(page);
  await connectClaude(page);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Filter conversations by agent' })
    .selectOption('claude');
  await expect(
    page.getByRole('button', { name: /Claude terminal conversation/ }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Claude terminal conversation/ })
    .first()
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Agent', exact: true }),
  ).toHaveValue('claude');
  await expect(
    page.getByRole('textbox', { name: 'Task prompt' }),
  ).toHaveAttribute('placeholder', 'Message Claude…  ⌘↵ to send');
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(page.getByText('acceptEdits', { exact: true })).toBeVisible();
});

test('harness setup errors stay actionable and laptop questions remain reachable in both themes', async ({
  page,
}) => {
  await openProject(page);
  await installClaudeFixture(page);
  await page.evaluate(
    () =>
      ((window as any).testClaudeConnectError =
        'Claude Code was not found. Install the official CLI or choose its executable.'),
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect Claude Code', exact: true })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Claude Code was not found' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Claude executable path' }),
  ).toBeVisible();
  await page.evaluate(() => ((window as any).testClaudeConnectError = ''));
  await page
    .getByRole('button', { name: 'Connect Claude Code', exact: true })
    .click();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Agent', exact: true })
    .selectOption('claude');
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Choose checks');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => (window as any).testClaudeQuestion());
  await page.setViewportSize({ width: 1100, height: 700 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.appearance = theme),
      theme,
    );
    const action = page.getByRole('button', { name: 'Submit answers' });
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(701);
    const send = await page
      .getByRole('button', { name: 'Send', exact: true })
      .boundingBox();
    expect(send!.y + send!.height).toBeLessThan(701);
    const stop = await page
      .getByRole('button', { name: 'Stop', exact: false })
      .boundingBox();
    expect(stop!.y + stop!.height).toBeLessThan(701);
    await page.screenshot({
      path: `test-results/screenshots/harness-${theme}.png`,
    });
  }
});

test('Claude Code alone is enough: setup connects it, new conversations use it, and nothing asks for Codex', async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem('fixture-onboarding', 'pending'),
  );
  await page.addInitScript(() => {
    const w = window as any;
    w.testCodexInstalled = false;
    w.testDetect = new Error(
      'Codex CLI not found. Install it (npm install -g @openai/codex, or brew install codex), then reconnect.',
    );
    w.testClaudeDetect = {
      path: '/Users/me/.local/bin/claude',
      version: '2.1.280',
      authenticated: true,
      authMethod: 'claude.ai',
    };
    w.testRecentProjects = [];
  });
  await page.reload();
  await installClaudeFixture(page);
  const setup = page.getByRole('region', { name: 'Set up Bindaas' });
  await expect(setup.getByRole('article', { name: 'Codex CLI' })).toContainText(
    'Not installed on this Mac.',
  );
  const claude = setup.getByRole('article', { name: 'Claude Code' });
  await expect(claude).toContainText(
    'Found Claude Code 2.1.280, signed in with claude.ai.',
  );

  // Skipping setup without any agent explains what is missing and leads back.
  await setup.getByRole('button', { name: 'Skip setup' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'No coding agent' }),
  ).toContainText('Install the Codex CLI or Claude Code to start.');
  await page.getByRole('button', { name: 'Set up an agent' }).click();
  await claude.getByRole('button', { name: 'Use Claude Code' }).click();
  await expect(claude).toContainText('Connected · Claude Code 2.1.280');
  await expect(setup.locator('.setup-step').first()).toHaveAttribute(
    'data-state',
    'done',
  );
  await setup.getByRole('button', { name: 'Open a project' }).click();
  await expect(setup).toHaveCount(0);

  // Only Claude can run: no agent picker, and new conversations use Claude.
  await expect(
    page.getByRole('combobox', { name: 'Agent', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.quiet-note')).toContainText('Claude starts');
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Claude-only task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: false }),
  ).toBeVisible();
  const calls = await page.evaluate(() => (window as any).testAgentCalls);
  expect(
    calls
      .filter((c: any) => c.command === 'agent_start_turn')
      .map((c: any) => c.args.harness),
  ).toEqual(['claude']);
  // The agent used last is remembered for new conversations.
  expect(
    calls.filter((c: any) => c.command === 'settings_save').at(-1)?.args.value
      .lastAgent,
  ).toBe('claude');
  // Nothing tried to start Codex or complained that it is missing.
  expect(
    calls.filter(
      (c: any) =>
        /^(agent_get_models|agent_get_account|agent_start_turn|agent_session_status)$/.test(
          c.command,
        ) &&
        c.args.harness !== 'claude' &&
        !c.args.threadId?.startsWith('claude:'),
    ),
  ).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('option', { name: /Write to Claude/ }),
  ).toBeVisible();
});

test('after a relaunch with only Claude connected, new conversations still start with Claude', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.testCodexInstalled = false;
    w.testSettingsPatch = { claudeEnabled: true };
  });
  await page.reload();
  await installClaudeFixture(page);
  await page.evaluate(
    () => ((window as any).testSettingsPatch = { claudeEnabled: true }),
  );
  await openProject(page);
  await expect(
    page.getByRole('combobox', { name: 'Agent', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('After relaunch');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).testAgentCalls
        .filter((c: any) => c.command === 'agent_start_turn')
        .map((c: any) => c.args.harness),
    ),
  ).toEqual(['claude']);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
