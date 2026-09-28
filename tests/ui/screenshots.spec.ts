// README images. Skipped in normal test runs; `npm run screenshots` refreshes
// docs/images/ on purpose, so ordinary test runs never modify tracked files.
import { test, expect, type Page } from '@playwright/test';
import { mockDesktop, openProject, reviewFixture } from './fixtures';

test.skip(
  !process.env.SCREENSHOTS,
  'Run `npm run screenshots` to refresh docs/images.',
);
test.use({ viewport: { width: 1280, height: 800 } });

async function capture(page: Page, name: string, appearance = 'dark') {
  await page.evaluate(
    (value) => (document.documentElement.dataset.appearance = value),
    appearance,
  );
  await page.mouse.move(0, 0);
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `docs/images/${name}.jpg`,
    type: 'jpeg',
    quality: 88,
    animations: 'disabled',
  });
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('conversation', async ({ page }) => {
  await openProject(page);
  await page.evaluate(
    () =>
      ((window as any).testReply =
        'Updated `hello.txt` and ran the tests.\n\n| Check | Result |\n|---|---|\n| npm test | ✓ passed |\n| Typecheck | ✓ clean |\n\n```ts\nexport const greeting = "after";\n```'),
  );
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Change hello with approval');
  await page.getByRole('button', { name: 'Send' }).click();
  await capture(page, 'approval');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await capture(page, 'conversation');
  await capture(page, 'conversation-light', 'light');
});

test('question', async ({ page }) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Ask questions before planning');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByRole('region', { name: 'Questions from Codex' }),
  ).toBeVisible();
  await capture(page, 'question');
});

test('review', async ({ page }) => {
  await reviewFixture(page);
  await capture(page, 'review');
});

test('history', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => {
    const w = window as any,
      now = Math.floor(Date.now() / 1000);
    const names = [
      ['Decide retention offers', 'waitingInput'],
      ['Investigate API errors', 'running'],
      ['Subscription pause design', 'planGenerated'],
      ['Improve onboarding copy', 'completed'],
      ['Migrate billing tables', 'failed'],
      ['Refactor auth middleware', 'completed'],
      ['Fix flaky checkout test', 'interrupted'],
      ['Tune cache headers', 'completed'],
    ];
    w.testRunThreads = names.map(([name, runStatus], i) => ({
      id: `h${i}`,
      name,
      preview: 'Clarify the flow and update the tests',
      runStatus,
      updatedAt: now - i * 50000,
      createdAt: now - i * 50000,
      status: { type: 'notLoaded' },
      cwd: '/fixture/project',
      model: 'gpt-5.5-codex',
    }));
  });
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.locator('.conversation-row').first()).toBeVisible();
  await capture(page, 'history');
});

test('setup', async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem('fixture-onboarding', 'pending'),
  );
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Set up Bindaas' }),
  ).toContainText('Found Codex');
  await capture(page, 'setup');
});
