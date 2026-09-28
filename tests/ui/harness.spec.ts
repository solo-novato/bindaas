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
