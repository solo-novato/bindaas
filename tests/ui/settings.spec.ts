import { test, expect } from '@playwright/test';
import {
  concurrentFixture,
  mockDesktop,
  openProject,
  resumeFixture,
  runningAnimations,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('session status shows Codex settings, usage, account limits and live token updates', async ({
  page,
}) => {
  await resumeFixture(page);
  await page
    .getByRole('button', { name: 'Session status', exact: true })
    .click();
  const panel = page.getByRole('dialog', { name: 'Session controls' });
  await expect(panel.getByText('12,500', { exact: true })).toBeVisible();
  await expect(panel.getByText('75% remaining', { exact: true })).toBeVisible();
  await expect(
    panel.getByText('fixture@example.test · pro', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('/fixture/project', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).testEmit('token-usage', {
      generation: 1,
      threadId: 'thread-1',
      usage: {
        total: {
          totalTokens: 15000,
          inputTokens: 13000,
          outputTokens: 2000,
          cachedInputTokens: 1000,
        },
        last: { inputTokens: 4500, totalTokens: 5000 },
        modelContextWindow: 100000,
      },
    }),
  );
  await expect(panel.getByText('15,000', { exact: true })).toBeVisible();
  await expect(panel.locator('meter').first()).toHaveAttribute('value', '4.5');
  await panel.getByRole('tab', { name: 'Permissions', exact: true }).click();
  await expect(panel.getByRole('radio', { name: /Workspace/ })).toBeChecked();
  await page.screenshot({ path: 'test-results/session-permissions.png' });
  await panel.getByRole('tab', { name: 'Overview' }).click();
  await page.screenshot({ path: 'test-results/session-status.png' });
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
});

test('permissions are explicit, managed-aware, and preserve mode and reasoning', async ({
  page,
}) => {
  await resumeFixture(page);
  await page.evaluate(() => ((window as any).testManaged = true));
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(
    panel.getByRole('radio', { name: /^Full access/ }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('option', { name: 'Never ask', exact: true }),
  ).toHaveCount(0);
  await panel.getByRole('radio', { name: /Read only/ }).check();
  await panel
    .getByRole('combobox', { name: 'Approval behavior' })
    .selectOption('untrusted');
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'codex_set_permissions',
        ).length,
    ),
  ).toBe(0);
  await panel.getByRole('button', { name: 'Apply permissions' }).click();
  await expect(panel.getByText('Permissions updated in Codex.')).toBeVisible();
  const call = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_set_permissions',
    ),
  );
  expect(call.args).toEqual({
    threadId: 'thread-1',
    permissions: ':read-only',
    approvalPolicy: 'untrusted',
  });
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Permissions', exact: true }),
  ).toContainText('Read only');
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Permissions', exact: true }),
  ).toContainText('Read only');
});

test('new conversations default to standard workspace access while explicit overrides need Apply', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('radio', { name: /^Workspace/ })).toBeChecked();
  await expect(
    panel.getByRole('combobox', { name: 'Approval behavior' }),
  ).toHaveValue('on-request');
  await panel.getByRole('radio', { name: /Read only/ }).check();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Permissions', exact: true }),
  ).toContainText('Workspace');
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  await panel.getByRole('radio', { name: /Read only/ }).check();
  await panel.getByRole('button', { name: 'Use for new conversation' }).click();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Inspect the project');
  await page.getByRole('button', { name: 'Send' }).click();
  const sent = await page.evaluate(() =>
    (window as any).testCalls.find(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(sent.args.permissions).toBe(':read-only');
  expect(sent.args.approvalPolicy).toBe('on-request');
});

test('failed permissions keep current access and missing usage is never shown as zero', async ({
  page,
}) => {
  await resumeFixture(page);
  await page.evaluate(() =>
    Object.assign(window as any, {
      testPermissionError: 'Codex rejected this change',
      testNoUsage: true,
      testLimitsError: 'Usage unavailable for this account',
    }),
  );
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  const panel = page.getByRole('dialog');
  await panel.getByRole('radio', { name: /Read only/ }).check();
  await panel.getByRole('button', { name: 'Apply permissions' }).click();
  await expect(panel.getByRole('alert')).toContainText('Codex rejected');
  await panel.getByRole('tab', { name: 'Overview' }).click();
  await expect(
    panel.getByText(
      'Codex has not reported token usage for this conversation.',
    ),
  ).toBeVisible();
  await expect(
    panel.getByText('Usage unavailable for this account'),
  ).toBeVisible();
  await expect(panel.locator('meter')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close session controls' }).click();
  await expect(
    page.getByRole('button', { name: 'Permissions', exact: true }),
  ).toContainText('Workspace');
});

test('permissions stay locked during a task awaiting approval', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Wait for approval');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await page.getByRole('button', { name: 'Permissions', exact: true }).click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('radio', { name: /Read only/ })).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: 'Apply permissions' }),
  ).toBeDisabled();
});

test('speed controls update four running conversations explicitly without interrupting or sending', async ({
  page,
}) => {
  await concurrentFixture(page);
  for (let n = 1; n <= 4; n++) {
    if (n > 1)
      await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Task prompt' })
      .fill(`Speed task ${n}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stop', exact: true }),
    ).toBeVisible();
  }
  await page
    .getByRole('button', { name: 'Session status', exact: true })
    .click();
  const controls = page.getByRole('region', { name: 'Speed controls' });
  const all = controls.getByRole('button', {
    name: 'Apply to all 4 running tasks',
  });
  await expect(all).toBeEnabled();
  await expect(
    controls
      .getByRole('combobox', { name: 'Processing speed' })
      .locator('option:checked'),
  ).toHaveText('Standard');
  await controls
    .getByRole('combobox', { name: 'Processing speed' })
    .selectOption({ label: 'Fast' });
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.filter(
        (c: any) => c.command === 'codex_set_speed',
      ),
    ),
  ).toHaveLength(0);
  await page.evaluate(() => ((window as any).testSpeedDelay = 150));
  await all.click();
  await expect(all).toBeDisabled();
  await expect(controls.getByText('Fast update results')).toBeVisible();
  await expect(controls.locator('li')).toHaveCount(4);
  await expect(
    controls.locator('li').filter({ hasText: 'Running task updated.' }),
  ).toHaveCount(4);
  await expect(controls).toContainText('Reported: Fast');
  await controls
    .getByRole('combobox', { name: 'Processing speed' })
    .selectOption({ label: 'Standard' });
  await controls.getByRole('button', { name: 'Apply to conversation' }).click();
  await expect(controls.getByText('Standard update results')).toBeVisible();
  await expect(controls.locator('li')).toHaveCount(1);
  const calls = await page.evaluate(() => (window as any).testCalls);
  const changes = calls.filter((c: any) => c.command === 'codex_set_speed');
  expect(changes).toHaveLength(2);
  expect(changes[0].args.fast).toBe(true);
  expect(changes[0].args.targets.map((t: any) => t.threadId)).toEqual([
    'concurrent-1',
    'concurrent-2',
    'concurrent-3',
    'concurrent-4',
  ]);
  expect(
    changes[0].args.targets.every((t: any) =>
      t.turnId.startsWith(`turn-${t.threadId}-`),
    ),
  ).toBe(true);
  expect(changes[1].args.fast).toBe(false);
  expect(changes[1].args.targets).toHaveLength(1);
  expect(
    calls.filter((c: any) => c.command === 'codex_start_turn'),
  ).toHaveLength(4);
  expect(calls.some((c: any) => c.command === 'codex_interrupt_turn')).toBe(
    false,
  );
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
});

test('speed controls show partial failures and recover from errors without claiming full success', async ({
  page,
}) => {
  await concurrentFixture(page);
  for (let n = 1; n <= 2; n++) {
    if (n > 1)
      await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Task prompt' })
      .fill(`Speed task ${n}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stop', exact: true }),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page
    .getByRole('button', { name: 'Session status', exact: true })
    .click();
  const controls = page.getByRole('region', { name: 'Speed controls' });
  await expect(
    controls.getByRole('button', { name: 'Apply to conversation' }),
  ).toBeDisabled();
  const all = controls.getByRole('button', {
    name: 'Apply to all 2 running tasks',
  });
  await expect(all).toBeEnabled();
  await page.evaluate(
    () => ((window as any).testSpeedError = 'Connection lost'),
  );
  await all.click();
  await expect(controls.getByRole('alert')).toContainText('Connection lost');
  await page.evaluate(() => {
    (window as any).testSpeedError = '';
    (window as any).testSpeedPartial = true;
  });
  await all.click();
  await expect(controls.locator('li')).toHaveCount(2);
  await expect(controls.locator('li').first()).toContainText(
    'Saved for future messages.',
  );
  await expect(controls.locator('li').first()).toContainText(
    'Running task could not be updated.',
  );
  await expect(controls.locator('li').first()).toContainText(
    'Live speed unsupported',
  );
  await expect(controls.locator('li').last()).toContainText(
    'Future messages could not be updated.',
  );
  await expect(controls.locator('li').last()).toContainText(
    'no running task was changed.',
  );
  await expect(
    controls.locator('li').filter({ hasText: 'Running task updated.' }),
  ).toHaveCount(0);
  await all.scrollIntoViewIfNeeded();
  await expect(all).toBeInViewport();
  await page.screenshot({
    path: 'test-results/screenshots/speed-controls.png',
  });
});

test('notification preference is saved and test alert uses native command', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Notify when tasks finish' })
    .check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls
          .filter((c: any) => c.command === 'settings_save')
          .at(-1).args.value.desktopNotifications,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Test notification' }).click();
  await expect(page.getByText(/Test notification requested/)).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'notification_test',
        ).length,
    ),
  ).toBe(1);
});

test('the full-access preference applies to every new conversation without opening permissions', async ({
  page,
}) => {
  await concurrentFixture(page);
  await expect(
    page.getByRole('button', { name: 'Permissions', exact: true }),
  ).toContainText('Workspace');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'New conversation access' })
    .selectOption('full');
  await expect(
    page.getByText('Full access lets Codex edit any file'),
  ).toBeVisible();
  const saved = await page.evaluate(
    () =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'settings_save')
        .at(-1).args.value,
  );
  expect(saved.newChatAccess).toBe('full');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  for (const prompt of [
    'First unrestricted task',
    'Second unrestricted task',
  ]) {
    await expect(
      page.getByRole('button', { name: 'Permissions', exact: true }),
    ).toContainText('Full access');
    await page.getByRole('textbox', { name: 'Task prompt' }).fill(prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
  }
  const calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_start_turn',
    ),
  );
  expect(calls).toHaveLength(2);
  for (const call of calls)
    expect(call.args).toMatchObject({
      permissions: ':danger-full-access',
      approvalPolicy: 'never',
    });
});

test('power saving removes every animation during work and saves only the motion preference', async ({
  page,
}) => {
  await concurrentFixture(page);
  await expect(page.locator('html')).toHaveAttribute(
    'data-motion',
    'expressive',
  );
  await page.keyboard.press('Meta+Shift+M');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'saving');
  const saved = await page.evaluate(
    () =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'settings_save')
        .at(-1).args.value,
  );
  expect(saved.motion).toBe('saving');
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Work without animation');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.task-header')).toHaveAttribute(
    'data-status',
    'inProgress',
  );
  expect(await runningAnimations(page)).toBe(0);
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('dialog', { name: 'Jump to anything' }),
  ).toBeVisible();
  expect(await runningAnimations(page)).toBe(0);
  await page
    .getByRole('combobox', { name: 'Search actions, tasks, and files' })
    .fill('expressive motion');
  await page.getByRole('option', { name: /Turn on expressive motion/ }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-motion',
    'expressive',
  );
  // Live work is visibly animated again once expressive motion returns.
  await expect.poll(() => runningAnimations(page, true)).toBeGreaterThan(0);
});

test('expressive motion settles to zero looping animations when idle', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => ((window as any).testReply = 'All set.'));
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Review this cleanup');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await expect.poll(() => runningAnimations(page, true)).toBe(0);
  await expect.poll(() => runningAnimations(page), { timeout: 4000 }).toBe(0);
});

test('first-run setup finds Codex, explains install, sign-in, and access, and finishes by opening a project', async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem('fixture-onboarding', 'pending');
    (window as any).testDetect = undefined;
  });
  await page.addInitScript(() => {
    (window as any).testDetect = new Error(
      'Codex CLI not found. Install it (npm install -g @openai/codex, or brew install codex), then reconnect.',
    );
  });
  await page.reload();
  const setup = page.getByRole('region', { name: 'Set up Bindaas' });
  await expect(setup).toBeVisible();
  const codex = setup.getByRole('article', { name: 'Codex CLI' });
  await expect(codex).toContainText('Not installed on this Mac.');
  await expect(codex.getByText('npm install -g @openai/codex')).toBeVisible();
  await expect(
    codex.getByRole('button', { name: /Sign in with ChatGPT/ }),
  ).toHaveCount(0);
  // Claude Code is offered too; either agent completes the first step.
  await expect(
    setup.getByRole('article', { name: 'Claude Code' }),
  ).toContainText('npm install -g @anthropic-ai/claude-code');
  // Installing Codex and checking again finds it and the signed-in account.
  await page.evaluate(() => ((window as any).testDetect = undefined));
  await codex.getByRole('button', { name: 'Check again' }).click();
  await expect(codex).toContainText(
    'Codex 0.155.0 · signed in as fixture@example.test',
  );
  await expect(codex).toContainText('Ready');
  await setup.getByRole('radio', { name: /Full access/ }).check();
  const saves = () =>
    page.evaluate(() =>
      (window as any).testCalls
        .filter((c: any) => c.command === 'settings_save')
        .map((c: any) => c.args.value),
    );
  await expect
    .poll(async () => (await saves()).at(-1)?.newChatAccess)
    .toBe('full');
  await setup.getByRole('button', { name: 'Open a project' }).click();
  await expect(setup).toHaveCount(0);
  await expect(
    page.getByText('fixture-project', { exact: true }).first(),
  ).toBeVisible();
  expect((await saves()).at(-1)?.onboardingComplete).toBe(true);
  // Setup never returns on its own, but can be run again from Settings.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await expect(
    page.getByRole('region', { name: 'Set up Bindaas' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start working' }).click();
  await expect(
    page.getByRole('region', { name: 'Set up Bindaas' }),
  ).toHaveCount(0);
});

test('open in default app refusals and diagnostics stay understandable', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => {
    const w = window as any;
    w.copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => w.copied.push(text) },
    });
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any) =>
      command === 'file_open_default'
        ? Promise.reject(
            "This file can run code or open something else, so Bindaas won't open it directly. Use Reveal in Finder instead.",
          )
        : invoke(command, args);
  });
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'hello.txt' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in default app' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Use Reveal in Finder instead',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  const report = await page.evaluate(() => (window as any).copied.at(-1));
  expect(report).toContain('Bindaas diagnostics');
  expect(report).toContain('"newChatAccess": "standard"');
  expect(report).not.toContain('fixture-project');
});
