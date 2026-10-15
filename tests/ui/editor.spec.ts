import { test, expect } from '@playwright/test';
import { mockDesktop, openProject } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await openProject(page);
});

test('a failed disk reload preserves the complete unsaved buffer', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'hello.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('Important unsaved work');
  await page.evaluate(() => {
    const w = window as any;
    w.testDiskChange('hello.txt', 'external change');
    w.testAgentInvoke = (command: string) => {
      if (command === 'file_read')
        throw new Error('File temporarily unavailable');
    };
  });
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'File temporarily unavailable',
  );
  await expect(page.locator('.cm-content')).toHaveText(
    'Important unsaved work',
  );
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
  await expect(page.getByRole('button', { name: /^Save/ })).toBeEnabled();
});

test('closing a file waits for saving and retains newer edits', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'hello.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('First saved revision');
  await page.evaluate(() => {
    const w = window as any;
    w.testAgentInvoke = (command: string) => {
      if (command === 'file_save')
        return new Promise<void>((resolve) => (w.finishFileSave = resolve));
    };
  });
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).finishFileSave))
    .toBe(true);
  await page.locator('.cm-content').fill('Newer unsaved revision');
  await page.evaluate(() => (window as any).finishFileSave());
  await expect(page.getByRole('alert')).toContainText(
    'New edits were made while saving',
  );
  await expect(page.locator('.cm-content')).toHaveText(
    'Newer unsaved revision',
  );
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
  await expect(
    page.getByRole('button', { name: 'Close hello.txt' }),
  ).toBeVisible();
});

test('a comparison stays attached to its source file when changing tabs', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'hello.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('My hello changes');
  await page.evaluate(() =>
    (window as any).testDiskChange('hello.txt', 'Hello from disk'),
  );
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.locator('.compare')).toContainText('Hello from disk');
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.file-toolbar')).toContainText('README.md');
  await expect(page.locator('.compare')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('Hello Workbench');
});

test('closing a loading file does not reopen it when the read finishes', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any;
    w.testAgentInvoke = (command: string) => {
      if (command === 'file_read')
        return new Promise<void>((resolve) => (w.finishFileRead = resolve));
    };
  });
  await page.getByRole('button', { name: 'hello.txt', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).finishFileRead))
    .toBe(true);
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await page.evaluate(() => (window as any).finishFileRead());
  await expect(page.getByText('Loading file…')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'A closer look at your code' }),
  ).toBeVisible();
  await expect(page.locator('.file-tabs > div')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toHaveCount(0);
});
