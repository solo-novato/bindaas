import { test, expect } from '@playwright/test';
import { mockDesktop, openProject } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('quick open clears old results while searching and never opens a stale match', async ({
  page,
}) => {
  await openProject(page);
  await page.keyboard.press('Meta+p');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  const input = launcher.getByRole('combobox');
  await input.fill('util');
  await expect(
    launcher.getByRole('option', { name: /util\.ts/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.testAgentInvoke = (command: string) => {
      if (command === 'project_file_search')
        return new Promise((resolve) => {
          w.resolveSearch = resolve;
        });
    };
  });
  await input.fill('guide');
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).resolveSearch))
    .toBe('function');
  await expect(launcher.getByText('Searching project…')).toBeVisible();
  await expect(launcher.getByRole('option')).toHaveCount(0);
  await input.press('Enter');
  await expect(launcher).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.some(
        (call: any) => call.command === 'file_read',
      ),
    ),
  ).toBe(false);
  await page.evaluate(() =>
    (window as any).resolveSearch([
      { path: 'docs/guide.md', fileName: 'guide.md', indices: null },
    ]),
  );
  await expect(
    launcher.getByRole('option', { name: /guide\.md/ }),
  ).toBeVisible();
  await expect(launcher.getByText('Searching project…')).toHaveCount(0);
  await input.press('Enter');
  await expect(launcher).toHaveCount(0);
  await expect(page.locator('.file-toolbar')).toContainText('docs/guide.md');
});

test('quick open discards searches when cleared or dismissed and keeps known files usable', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => {
    const w = window as any;
    w.pendingSearches = {};
    w.testAgentInvoke = (command: string, args: any) => {
      if (command === 'project_file_search')
        return new Promise((resolve) => {
          w.pendingSearches[args.query] = resolve;
        });
    };
  });
  const prompt = page.getByRole('textbox', { name: 'Task prompt' });
  await prompt.focus();
  await page.keyboard.press('Meta+p');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  const input = launcher.getByRole('combobox');
  await input.fill('util');
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).pendingSearches.util),
    )
    .toBe('function');
  await input.fill('');
  await page.evaluate(() =>
    (window as any).pendingSearches.util([
      { path: 'src/lib/deep/util.ts', fileName: 'util.ts', indices: null },
    ]),
  );
  await expect(launcher.getByRole('option', { name: /util\.ts/ })).toHaveCount(
    0,
  );
  await expect(launcher.getByText('Searching project…')).toHaveCount(0);
  await input.fill('guide');
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).pendingSearches.guide),
    )
    .toBe('function');
  await input.press('Escape');
  await expect(prompt).toBeFocused();
  await page.evaluate(() =>
    (window as any).pendingSearches.guide([
      { path: 'docs/guide.md', fileName: 'guide.md', indices: null },
    ]),
  );
  await page.keyboard.press('Meta+p');
  await expect(launcher.getByRole('option', { name: /guide\.md/ })).toHaveCount(
    0,
  );
  await input.fill('hello');
  await expect(
    launcher.getByRole('option', { name: /hello\.txt/ }),
  ).toBeVisible();
  await input.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('before');
});

test('quick open without a project does not show a stuck search indicator', async ({
  page,
}) => {
  await page.keyboard.press('Meta+p');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  await launcher.getByRole('combobox').fill('hello');
  await expect(launcher.getByText('No match yet')).toBeVisible();
  await expect(launcher.getByText('Searching project…')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.some(
        (call: any) => call.command === 'project_file_search',
      ),
    ),
  ).toBe(false);
});
