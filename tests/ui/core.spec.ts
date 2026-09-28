import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { concurrentFixture, mockDesktop, openProject } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('project switcher supports keyboard search, dismissal, current-project reuse, and exact-path selection', async ({
  page,
}) => {
  await page.evaluate(
    () =>
      ((window as any).testRecentProjects = [
        '/work/alpha-app',
        '/personal/alpha-app',
        '/work/billing-api',
      ]),
  );
  await openProject(page);
  const trigger = page.locator('.project-button');
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Switch project' });
  const search = picker.getByRole('combobox', {
    name: 'Search recent projects',
  });
  await expect(search).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await search.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'project_open',
        ).length,
    ),
  ).toBe(1);
  await trigger.click();
  await search.fill('alpha');
  await expect(picker.getByRole('option')).toHaveCount(2);
  await search.press('ArrowDown');
  await expect(picker.getByRole('option').nth(1)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Meta+4');
  await expect(
    page.getByRole('region', { name: 'Conversation history' }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await search.fill('alpha');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as any).testCalls
            .filter((c: any) => c.command === 'project_open')
            .at(-1).args.path,
      ),
    )
    .toBe('/personal/alpha-app');
  await trigger.click();
  await search.fill('nothing-matches');
  await expect(picker).toContainText('No recent projects match this search.');
  await expect(
    picker.getByRole('button', { name: 'Open another folder…' }),
  ).toBeEnabled();
  await search.fill('');
  await page.setViewportSize({ width: 1000, height: 650 });
  for (const appearance of ['dark', 'light']) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.appearance = value),
      appearance,
    );
    if (process.env.WORKBENCH_AXE_PATH) {
      await page.evaluate(readFileSync(process.env.WORKBENCH_AXE_PATH, 'utf8'));
      const violations = await page.evaluate(async () =>
        (
          await (window as any).axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          })
        ).violations.map((v: any) => ({
          id: v.id,
          nodes: v.nodes.map((n: any) => n.target),
        })),
      );
      expect(violations).toEqual([]);
    }
    await page.screenshot({
      path: `test-results/screenshots/project-switcher-${appearance}.png`,
      animations: 'disabled',
    });
  }
  await picker.getByRole('button', { name: 'Close project switcher' }).click();
  await expect(trigger).toBeFocused();
});

test('project switcher preserves dirty edits on cancel and recovers from missing folders', async ({
  page,
}) => {
  await page.evaluate(
    () => ((window as any).testRecentProjects = ['/work/another-project']),
  );
  await openProject(page);
  await page.getByRole('button', { name: 'hello.txt' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('Important unsaved changes');
  await page.locator('.project-button').click();
  await page
    .getByRole('option')
    .filter({ hasText: '/work/another-project' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Unsaved changes', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(
    'Important unsaved changes',
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'project_open',
        ).length,
    ),
  ).toBe(1);
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.evaluate(() => ((window as any).testProjectOpenFailure = true));
  await page.locator('.project-button').click();
  await page
    .getByRole('option')
    .filter({ hasText: '/work/another-project' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'This project folder is no longer available.',
  );
  await expect(page.locator('.project-button')).toContainText(
    'fixture-project',
  );
  await expect(page.locator('.cm-content')).toContainText(
    'Important unsaved changes',
  );
});

test('project switcher explains active work without interrupting it', async ({
  page,
}) => {
  await page.evaluate(
    () => ((window as any).testRecentProjects = ['/work/another-project']),
  );
  await concurrentFixture(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Work on the current project');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.project-button').click();
  const picker = page.getByRole('dialog', { name: 'Switch project' });
  await expect(picker).toContainText(
    'Finish running tasks before switching projects.',
  );
  await expect(
    picker.getByRole('button', { name: 'Open another folder…' }),
  ).toBeDisabled();
  await picker.getByRole('combobox').fill('another');
  await expect(picker.getByRole('option')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await picker.getByRole('combobox').press('Enter');
  await expect(picker).toBeVisible();
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(calls.filter((c: any) => c.command === 'project_open')).toHaveLength(
    1,
  );
  expect(
    calls.filter((c: any) => c.command === 'codex_interrupt_turn'),
  ).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
});

test('idle launch is quiet; tree and editor are lazy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await expect(
    page.getByRole('heading', { name: 'What are we building?' }),
  ).toBeVisible();
  await openProject(page);
  const calls = await page.evaluate(() => (window as any).testCalls);
  expect(calls.some((c: any) => c.command === 'codex_get_models')).toBe(false);
  expect(
    calls
      .filter((c: any) => c.command === 'file_list_directory')
      .map((c: any) => c.args.relativePath),
  ).toEqual(['']);
  expect(await page.locator('.cm-editor').count()).toBe(0);
  await page.getByRole('button', { name: 'src' }).click();
  await page.getByRole('button', { name: 'main.ts' }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'false',
  );
  await page.getByRole('button', { name: 'hello.txt' }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('approval details, exact decision, live diff and completion', async ({
  page,
}) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Change hello with approval');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByRole('heading', { name: 'registry.npmjs.org · https' }),
  ).toBeVisible();
  await expect(
    page.getByText('Waiting for approval', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await expect(
    page.getByText('Updated hello.txt and ran the tests.'),
  ).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (c: any) => c.command === 'codex_respond_server_request',
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args.decision).toBe('accept');
  await expect(page.locator('.diff-body')).toBeVisible();
  await page.screenshot({
    path: 'test-results/screenshots/workbench-task.png',
    fullPage: true,
  });
});

test('dirty edits survive disk changes, save refuses conflict, reload is explicit', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'hello.txt' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('my unsaved text');
  await page.evaluate(() =>
    (window as any).testDiskChange('hello.txt', 'external text'),
  );
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(
    page.getByText('CONFLICT: File changed on disk').first(),
  ).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('my unsaved text');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByText('Current disk content')).toBeVisible();
  await expect(page.locator('.compare')).toContainText('external text');
  await page.getByRole('button', { name: 'Close comparison' }).click();
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('external text');
});

test('Markdown preview is safe and split keeps one editor', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('button', { name: 'README.md' }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Hello Workbench' }),
  ).toBeVisible();
  expect(await page.locator('.markdown script').count()).toBe(0);
  expect(await page.locator('.cm-editor').count()).toBe(0);
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await page.getByRole('link', { name: 'Other file' }).click();
  await expect(page.locator('.file-toolbar')).toContainText('hello.txt');
});

test('disconnect preserves unknown outcome and history reconciles', async ({
  page,
}) => {
  await openProject(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('disconnect');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByText(
      'Connection lost. The task outcome is unknown until history is reconciled.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Restart and reconcile' }).click();
  await expect(page.getByText('Historical result from Codex.')).toBeVisible();
});

test('dirty tab close offers cancel and preserves buffer', async ({ page }) => {
  await openProject(page);
  await page.getByRole('button', { name: 'hello.txt' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('do not lose this');
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('do not lose this');
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await page.getByRole('button', { name: 'Don’t Save' }).click();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});
