import { test, expect, type Page } from '@playwright/test';
import { concurrentFixture, mockDesktop, openProject } from './fixtures';

// One project per window. The native side routes agent events to the window that
// shows each conversation's project; these journeys cover the window's own part.

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

const argsOf = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as any).testCalls
        .filter((c: any) => c.command === name)
        .map((c: any) => c.args),
    command,
  );
const opened = async (page: Page) =>
  (await argsOf(page, 'window_open')).map((a: any) => a.path ?? null);

async function sendTask(page: Page) {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Long task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
}

test('new windows open from the keyboard, launcher, and switcher, and open projects are brought forward', async ({
  page,
}) => {
  await page.evaluate(
    () => ((window as any).testRecentProjects = ['/work/api', '/work/blog']),
  );
  await openProject(page);
  await page.keyboard.press('Meta+Shift+n');
  await expect.poll(() => opened(page)).toEqual([null]);

  await page.keyboard.press('Meta+k');
  const launcher = page.getByRole('dialog', { name: 'Jump to anything' });
  await launcher.getByRole('combobox').fill('new window');
  await launcher.getByRole('option', { name: /New window/ }).click();
  await expect.poll(() => opened(page)).toEqual([null, null]);

  await page.evaluate(
    () =>
      ((window as any).testOtherWindows = {
        count: 1,
        projects: ['/work/api'],
      }),
  );
  const trigger = page.locator('.project-button');
  const picker = page.getByRole('dialog', { name: 'Switch project' });
  await trigger.click();
  const api = picker.getByRole('option', { name: /\/work\/api/ });
  await expect(api).toContainText('Open in another window');
  await api.click();
  await expect.poll(() => opened(page)).toEqual([null, null, '/work/api']);

  await trigger.click();
  await picker.getByRole('combobox').fill('blog');
  await picker.getByRole('combobox').press('Meta+Enter');
  await expect
    .poll(() => opened(page))
    .toEqual([null, null, '/work/api', '/work/blog']);

  await trigger.click();
  await picker.getByRole('button', { name: 'New window', exact: true }).click();
  await expect
    .poll(() => opened(page))
    .toEqual([null, null, '/work/api', '/work/blog', null]);
  // This window never left its project.
  expect(await argsOf(page, 'project_open')).toHaveLength(1);
  await expect(trigger).toContainText('fixture-project');
});

test('closing one of several windows asks about its own tasks; closing the last window quits', async ({
  page,
}) => {
  await sendTask(page);
  const closeWindow = () =>
    page.evaluate(() => (window as any).testEmitApp('tauri://close-requested'));
  const dialog = page.getByRole('dialog', { name: 'Tasks are still running' });

  await page.evaluate(
    () =>
      ((window as any).testOtherWindows = {
        count: 1,
        projects: ['/work/api'],
      }),
  );
  await closeWindow();
  await expect(dialog).toContainText(
    'Close this window and stop the running tasks in fixture-project?',
  );
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await argsOf(page, 'window_close')).toHaveLength(0);

  // The last window: the app asks each window in turn before quitting.
  await page.evaluate(() => ((window as any).testOtherWindows = undefined));
  await closeWindow();
  await expect
    .poll(async () => (await argsOf(page, 'app_request_quit')).length)
    .toBe(1);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).testEmitApp('workbench://quit-requested'),
  );
  await expect(dialog).toContainText('Quit and interrupt all running tasks?');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect
    .poll(() => argsOf(page, 'app_quit_step'))
    .toEqual([{ approved: false }]);
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();

  await page.evaluate(
    () =>
      ((window as any).testOtherWindows = {
        count: 1,
        projects: ['/work/api'],
      }),
  );
  await closeWindow();
  await dialog
    .getByRole('button', { name: 'Close and stop tasks', exact: true })
    .click();
  await expect
    .poll(async () => (await argsOf(page, 'window_close')).length)
    .toBe(1);
  // The native side stops this project's tasks; the window never interrupts others.
  expect(await argsOf(page, 'codex_interrupt_turn')).toHaveLength(0);
});

test('an idle window agrees to quit without asking', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() =>
    (window as any).testEmitApp('workbench://quit-requested'),
  );
  await expect
    .poll(() => argsOf(page, 'app_quit_step'))
    .toEqual([{ approved: true }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Another window cancelled that quit: this one stays fully usable.
  await page.evaluate(() =>
    (window as any).testEmitApp('workbench://quit-requested'),
  );
  await expect
    .poll(() => argsOf(page, 'app_quit_step'))
    .toEqual([{ approved: true }, { approved: true }]);
  await page.evaluate(() => {
    const w = window as any;
    w.testOtherWindows = { count: 1, projects: [] };
    w.testEmitApp('tauri://close-requested');
  });
  await expect
    .poll(async () => (await argsOf(page, 'window_close')).length)
    .toBe(1);
});

test('preferences changed in another window apply here', async ({ page }) => {
  await openProject(page);
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-motion',
    'saving',
  );
  await page.evaluate(() => {
    const w = window as any;
    w.testSettingsPatch = { motion: 'saving' };
    w.testEmitApp('workbench://settings-changed');
  });
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'saving');
});

test('new windows open the project chosen for them, or start blank, and listen only for their own events', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__.metadata.currentWindow.label =
      'project-1';
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'What are we building?' }),
  ).toBeVisible();
  // A blank window does not reopen the last project; that is the main window's job.
  expect(await argsOf(page, 'project_open')).toHaveLength(0);
  const targets = (await argsOf(page, 'plugin:event|listen'))
    .filter((a: any) => /^(agent|workbench):\/\//.test(a.event))
    .map((a: any) => JSON.stringify(a.target));
  expect(targets.length).toBeGreaterThan(5);
  expect(new Set(targets)).toEqual(
    new Set([JSON.stringify({ kind: 'WebviewWindow', label: 'project-1' })]),
  );

  await page.addInitScript(() => {
    (window as any).testInitialProject = '/work/api';
  });
  await page.reload();
  await expect
    .poll(async () =>
      (await argsOf(page, 'project_open')).map((a: any) => a.path),
    )
    .toEqual(['/work/api']);
});
