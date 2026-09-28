// Refactor safety net: snapshots the computed styles of every element in key states.
// Capture before and after a CSS or markup refactor, then compare with
// `node scripts/style-diff.mjs before.json after.json`. See CONTRIBUTING.md.
import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import {
  concurrentFixture,
  mockDesktop,
  openProject,
  reviewFixture,
} from './fixtures';

const out = process.env.STYLE_SNAPSHOT;
test.skip(!out, 'Run `npm run styles:snapshot` to capture computed styles.');
test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });

const snapshots: Record<string, unknown> = {};
async function snap(page: Page, name: string) {
  for (const appearance of ['dark', 'light']) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.appearance = value),
      appearance,
    );
    await page.waitForTimeout(50);
    snapshots[`${name}:${appearance}`] = await page.evaluate(() => {
      const result: Record<string, Record<string, string>> = {};
      const path = (el: Element): string => {
        const parts: string[] = [];
        for (let node: Element | null = el; node; node = node.parentElement) {
          const index = node.parentElement
            ? Array.prototype.indexOf.call(node.parentElement.children, node)
            : 0;
          parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        }
        return parts.join('>');
      };
      for (const el of document.querySelectorAll('*')) {
        for (const pseudo of [null, '::before', '::after']) {
          const style = getComputedStyle(el, pseudo);
          if (
            pseudo &&
            (style.content === 'none' || style.content === 'normal')
          )
            continue;
          const values: Record<string, string> = {};
          for (let i = 0; i < style.length; i++) {
            const property = style[i];
            values[property] = style.getPropertyValue(property);
          }
          result[path(el) + (pseudo ?? '')] = values;
        }
      }
      return result;
    });
  }
  await page.evaluate(
    () => (document.documentElement.dataset.appearance = 'dark'),
  );
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});
test.afterAll(() => {
  if (out) writeFileSync(out, JSON.stringify(snapshots));
});

test('styles', async ({ page }) => {
  await snap(page, 'welcome');
  await openProject(page);
  await snap(page, 'project');
  await page.getByRole('button', { name: 'README.md' }).click();
  await page.waitForTimeout(400);
  await snap(page, 'files');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Change hello with approval');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByRole('button', { name: 'Allow once', exact: true }),
  ).toBeVisible();
  await snap(page, 'approval');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByText('✓ Task completed')).toBeVisible();
  await snap(page, 'completed');
  await page.keyboard.press('Meta+k');
  await snap(page, 'launcher');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await snap(page, 'settings');
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await snap(page, 'history');
});

test('questions and review', async ({ page }) => {
  await openProject(page);
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Ask questions before planning');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(
    page.getByRole('region', { name: 'Questions from Codex' }),
  ).toBeVisible();
  await snap(page, 'question');
});

test('review', async ({ page }) => {
  await reviewFixture(page);
  await snap(page, 'review');
});

test('running', async ({ page }) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Inspect');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await snap(page, 'running');
});
