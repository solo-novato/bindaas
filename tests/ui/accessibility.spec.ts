import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  auditReport,
  completePlan,
  mockDesktop,
  openProject,
  reviewFixture,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('accessibility audit across working destinations and dialogs', async ({
  page,
}) => {
  test.skip(
    !process.env.WORKBENCH_AXE_PATH,
    'Set WORKBENCH_AXE_PATH to a local axe-core script to run the extended audit.',
  );
  test.setTimeout(120000);
  // Audit settled colors, not frames of theme or hover transitions.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const axe = readFileSync(process.env.WORKBENCH_AXE_PATH!, 'utf8');
  const findings: unknown[] = [];
  const checked: string[] = [];
  async function audit(name: string) {
    await page.evaluate(axe);
    const result = await page.evaluate(async () => {
      const result = await (window as any).axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
      });
      return result.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n: any) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      }));
    });
    checked.push(name);
    if (result.length) findings.push({ name, violations: result });
    writeFileSync(
      auditReport,
      JSON.stringify({ checked, violations: findings }, null, 2),
    );
  }
  await openProject(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const appearance of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await audit(`${appearance}: welcome`);
    await page
      .getByRole('button', { name: 'Jump to anything', exact: true })
      .click();
    await audit(`${appearance}: launcher`);
    await page.keyboard.press('Escape');
    await page
      .getByRole('complementary', { name: 'Project explorer' })
      .getByRole('button', { name: 'src' })
      .click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await audit(`${appearance}: explorer menu`);
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Task prompt' }).click();
    await page.keyboard.type('@');
    await expect(
      page.getByRole('listbox', { name: 'Files to mention' }),
    ).toBeVisible();
    await audit(`${appearance}: mention menu`);
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Task prompt' }).fill('');
    await page
      .getByRole('button', { name: 'Permissions', exact: true })
      .click();
    await audit(`${appearance}: permissions`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await page
      .getByRole('button', { name: 'Preview attachment brief.md' })
      .click();
    await expect(page.getByRole('dialog').locator('pre')).toBeVisible();
    await audit(`${appearance}: attachment`);
    await page.keyboard.press('Escape');
    await page
      .getByRole('complementary', { name: 'Project explorer' })
      .getByRole('button', { name: 'hello.txt', exact: true })
      .click();
    await expect(page.locator('.cm-editor')).toBeVisible();
    await page
      .getByRole('button', { name: 'Add file context for current editor' })
      .click();
    const picker = page.getByRole('dialog', { name: 'Add file context' });
    await expect(
      picker.getByRole('radio', { name: 'Editor snapshot', exact: true }),
    ).toBeVisible();
    await audit(`${appearance}: file context picker`);
    await picker
      .getByRole('radio', { name: 'Editor snapshot', exact: true })
      .check();
    await picker
      .getByRole('button', { name: 'Add editor snapshot', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: 'Preview context hello.txt · editor snapshot',
        exact: true,
      })
      .click();
    const context = page.getByRole('dialog', { name: 'Context preview' });
    await expect(
      context.getByRole('textbox', { name: 'Context text' }),
    ).toBeVisible();
    await audit(`${appearance}: editor context preview`);
    await context
      .getByRole('button', { name: 'Remove context', exact: true })
      .click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
  }
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Ask questions before planning');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  for (const appearance of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await audit(`${appearance}: questions`);
    const animation = await page
      .locator('.agent-status i')
      .evaluate((node) => getComputedStyle(node).animationName);
    expect(animation).toBe('none');
  }
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page
    .getByRole('button', { name: /hello.txt/ })
    .first()
    .click();
  await expect(page.locator('.cm-editor')).toBeVisible();
  await audit('light: file viewer');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await audit('light: settings');
  const reviewContext = await page
    .context()
    .browser()!
    .newContext({
      baseURL: 'http://127.0.0.1:1420',
      viewport: { width: 1440, height: 940 },
      reducedMotion: 'reduce',
    });
  page = await reviewContext.newPage();
  await mockDesktop(page);
  await page.goto('/');
  await reviewFixture(page);
  for (const appearance of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await audit(`${appearance}: review`);
  }
  writeFileSync(
    auditReport,
    JSON.stringify({ checked, violations: findings }, null, 2),
  );
  await completePlan(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  for (const appearance of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.appearance = value;
    }, appearance);
    await audit(`${appearance}: proposed plan`);
  }
  await reviewContext.close();
  expect(findings, `See ${auditReport}`).toEqual([]);
});
