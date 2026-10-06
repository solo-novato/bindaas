import { test, expect } from '@playwright/test';
import {
  completePlan,
  mockDesktop,
  openProject,
  proposedPlanFixture,
  reviewFixture,
  reviewPatch,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('review moves through exact patches and prepares a scoped follow-up without sending', async ({
  page,
}) => {
  await reviewFixture(page);
  const review = page.getByRole('region', { name: 'Change review' });
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(page.locator('.project-pane')).toHaveCount(0);
  await expect(review).toContainText('0 of 2 reviewed');
  await expect(review).toContainText('This file had edits before the task.');
  await review.locator('.review-checks summary').click();
  await expect(review.locator('.review-checks')).toContainText('exit 1');
  await review.locator('.review-checks summary').click();
  await page
    .getByRole('textbox', { name: 'Task prompt' })
    .fill('Keep my existing draft.');
  await review
    .getByRole('button', { name: 'Next change', exact: true })
    .click();
  await review
    .getByRole('button', { name: 'Check regressions', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue(
    /Keep my existing draft\.[\s\S]*Check the attached change in src\/main.ts/,
  );
  await page
    .getByRole('button', {
      name: 'Preview context src/main.ts · change 2',
      exact: true,
    })
    .click();
  const preview = page.getByRole('dialog', { name: 'Context preview' });
  await expect(preview).toContainText('+const retries = 3;');
  await expect(preview).not.toContainText('const enabled');
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (c: any) => c.command === 'codex_start_turn',
        ).length,
    ),
  ).toBe(1);
  await review.getByRole('button', { name: 'Mark reviewed & next' }).click();
  await expect(review).toContainText('1 of 2 reviewed');
  await expect(review.locator('.diff-toolbar strong')).toHaveText('README.md');
  await review.getByRole('button', { name: 'Mark reviewed & next' }).click();
  await expect(review).toContainText('2 of 2 reviewed');
  await review.getByRole('button', { name: 'Back to chat' }).click();
  await expect(page.locator('.inspector')).toBeVisible();
  await page
    .getByRole('button', { name: /^Changes/ })
    .first()
    .click();
  await expect(review).toContainText('2 of 2 reviewed');
  await page.evaluate((diff) => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    w.testEmit('turn-diff', {
      threadId: t.id,
      turnId: t.turn.id,
      diff: diff.replace('+const retries = 3;', '+const retries = 5;'),
      truncated: false,
    });
  }, reviewPatch);
  await expect(review).toContainText('1 of 2 reviewed');
  await review
    .getByRole('button', { name: 'Show unreviewed', exact: true })
    .click();
  await expect(review.locator('.review-file-list > button')).toHaveCount(1);
  await review.locator('.review-file-list > button').click();
  await expect(review.locator('.diff-body')).toContainText('retries = 5');
  await page.screenshot({
    path: 'test-results/screenshots/review-workspace.png',
    animations: 'disabled',
  });
});

test('review handles large patches with bounded rendering and keyboard hunk navigation', async ({
  page,
}) => {
  const patch = [
    'diff --git a/large.ts b/large.ts',
    '--- a/large.ts',
    '+++ b/large.ts',
    '@@ -0,0 +1,5000 @@',
    ...Array.from({ length: 5000 }, (_, i) => `+const item${i} = ${i};`),
    '@@ -10 +6000 @@',
    '-lastBefore',
    '+lastAfter',
    '',
  ].join('\n');
  await reviewFixture(page, patch);
  const review = page.getByRole('region', { name: 'Change review' });
  expect(await review.locator('.diff-line').count()).toBeLessThanOrEqual(160);
  await review
    .getByRole('combobox', { name: 'Change in file' })
    .selectOption('1');
  await expect(review.locator('.diff-body')).toContainText('lastAfter');
  expect(await review.locator('.diff-line').count()).toBeLessThanOrEqual(160);
  await review.getByRole('button', { name: 'Explain', exact: true }).click();
  await page
    .getByRole('button', { name: 'Preview context large.ts · change 2' })
    .click();
  const preview = page.getByRole('dialog', { name: 'Context preview' });
  await expect(preview).toContainText('lastAfter');
  await expect(preview).not.toContainText('item4999');
});

test('review remains useful without Git and never marks incomplete or missing patches reviewed', async ({
  page,
}) => {
  await reviewFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    w.testSetGit({ available: false, files: [], unstaged: '' });
    w.testEmit('baseline', {
      threadId: t.id,
      git: { available: false, files: [] },
    });
    w.concurrentFinish(t.id);
  });
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await page
    .getByRole('button', { name: /^Changes/ })
    .first()
    .click();
  const review = page.getByRole('region', { name: 'Change review' });
  await expect(
    review.getByRole('button', { name: 'Repository', exact: true }),
  ).toBeDisabled();
  await expect(review.locator('.diff-body')).toContainText('enabled');
  await page.evaluate((diff) => {
    const w = window as any;
    const t = w.concurrentThreads['concurrent-1'];
    w.testEmit('turn-diff', {
      threadId: t.id,
      turnId: t.turn.id,
      diff,
      truncated: true,
    });
  }, reviewPatch);
  await expect(
    review.getByRole('button', { name: 'Mark reviewed & next' }),
  ).toBeDisabled();
  await expect(review).toContainText('Diff truncated');
});

test('review stays readable on a laptop in light and dark appearance', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await reviewFixture(page);
  for (const appearance of ['dark', 'light']) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.appearance = mode;
    }, appearance);
    const review = page.getByRole('region', { name: 'Change review' });
    await expect(review.locator('.diff-body')).toBeVisible();
    const layout = await page.evaluate(() => {
      const box = document.querySelector('.diff-body')!.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        width: box.width,
        height: box.height,
        bottom: box.bottom,
      };
    });
    await page.screenshot({
      path: `test-results/screenshots/review-${appearance}-1000.png`,
      animations: 'disabled',
    });
    expect(layout.overflow).toBe(false);
    expect(layout.width).toBeGreaterThan(500);
    expect(layout.height).toBeGreaterThan(140);
    expect(layout.bottom).toBeLessThan(800);
  }
});

test('review explains missing patches and preserves deletion and rename details', async ({
  page,
}) => {
  const patch = [
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    'diff --git a/removed.txt b/removed.txt',
    '--- a/removed.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-removed content',
    '',
  ].join('\n');
  await reviewFixture(page, patch);
  await page.evaluate(
    (diff) =>
      (window as any).testSetGit({
        available: true,
        unstaged: diff,
        files: [
          { path: 'new.txt', status: 'R ' },
          { path: 'removed.txt', status: ' D' },
          { path: 'notes.txt', status: '??' },
        ],
      }),
    patch,
  );
  const review = page.getByRole('region', { name: 'Change review' });
  await review.getByRole('button', { name: 'Repository', exact: true }).click();
  await expect(review.locator('.diff-body')).toContainText(
    'rename from old.txt',
  );
  await review
    .getByRole('button', { name: /removed.txt Project root/ })
    .click();
  await expect(
    review.getByRole('combobox', { name: 'Change in file' }),
  ).toHaveValue('0');
  await expect(review.locator('.diff-body')).toContainText('removed content');
  await review.locator('.diff-metadata summary').click();
  await expect(review.locator('.diff-metadata')).toContainText('+++ /dev/null');
  await review.getByRole('button', { name: /notes.txt Project root/ }).click();
  await expect(review).toContainText(
    'This file is untracked. Git has no patch for it yet.',
  );
  await expect(
    review.getByRole('button', { name: 'Mark reviewed & next' }),
  ).toBeDisabled();
  await review
    .getByRole('combobox', { name: 'Git diff scope' })
    .selectOption('staged');
  await expect(review).toContainText('0 of 3 reviewed');
  await expect(review.locator('.diff-body')).toHaveCount(0);
});

test('compact inspector opens on request and Escape returns focus without changing desktop preferences', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openProject(page);
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Show inspector', exact: true })
    .click();
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Close inspector' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.inspector')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show inspector', exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 940 });
  await expect(page.locator('.inspector')).toBeVisible();
});

test('pane dividers resize from the keyboard and pointer while preserving readable space and preferences', async ({
  page,
}) => {
  await openProject(page);
  const left = page.getByRole('separator', { name: 'Resize explorer' });
  const right = page.getByRole('separator', { name: 'Resize inspector' });
  await left.focus();
  await page.keyboard.press('ArrowRight');
  await expect(left).toHaveAttribute('aria-valuenow', '250');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(left).toHaveAttribute('aria-valuenow', '210');
  await page.keyboard.press('Home');
  await expect(left).toHaveAttribute('aria-valuenow', '180');
  await page.keyboard.press('End');
  await expect(left).toHaveAttribute('aria-valuenow', '380');
  await right.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(right).toHaveAttribute('aria-valuenow', '410');
  await page.keyboard.press('End');
  await expect(right).toHaveAttribute('aria-valuenow', '578');
  const saved = await page.evaluate(() =>
    (window as any).testCalls.filter(
      (call: any) => call.command === 'settings_save',
    ),
  );
  expect(saved.at(-1).args.value.paneSizes).toEqual({ left: 380, right: 578 });
  await page.setViewportSize({ width: 1151, height: 800 });
  // Pane limits follow the window's resize event; wait for it before measuring.
  await expect(right).toHaveAttribute('aria-valuenow', '300');
  expect(
    (await page.locator('main').boundingBox())!.width,
  ).toBeGreaterThanOrEqual(480);
  expect(
    await page.evaluate(
      () =>
        (window as any).testCalls.filter(
          (call: any) => call.command === 'settings_save',
        ).length,
    ),
  ).toBe(saved.length);
  await page.setViewportSize({ width: 1440, height: 940 });
  await expect(left).toHaveAttribute('aria-valuenow', '380');
  await expect(right).toHaveAttribute('aria-valuenow', '578');
  await right.focus();
  await page.keyboard.press('Enter');
  await expect(right).toHaveAttribute('aria-valuenow', '400');
  await left.focus();
  await page.keyboard.press('Enter');
  const bounds = (await left.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 60, bounds.y + 100);
  await page.mouse.up();
  await expect(left).toHaveAttribute('aria-valuenow', '300');
  await left.dblclick();
  await expect(left).toHaveAttribute('aria-valuenow', '240');
  await expect(left).toBeFocused();
});

test('empty inspector explains the selected source and explicit refresh discovers changes', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Collapse explorer' }).click();
  await page.getByRole('button', { name: 'Show explorer' }).press('Enter');
  await expect(
    page.getByRole('button', { name: 'Collapse explorer' }),
  ).toBeFocused();
  await openProject(page);
  const inspector = page.getByRole('complementary', {
    name: 'Changes inspector',
  });
  await expect(inspector).toContainText('No changes in this snapshot');
  await inspector.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(inspector).toContainText('No task selected');
  await inspector
    .getByRole('button', { name: 'Repository', exact: true })
    .click();
  const before = await page.evaluate(() => (window as any).testCalls.length);
  await page.evaluate(() => {
    (window as any).testSetGit({
      files: [{ path: 'hello.txt', status: ' M' }],
      unstaged:
        'diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+outside edit\n',
    });
  });
  await inspector.getByRole('button', { name: 'Refresh changes' }).click();
  await expect(inspector.locator('.diff-body')).toContainText('outside edit');
  const calls = await page.evaluate(
    (start) => (window as any).testCalls.slice(start),
    before,
  );
  expect(
    calls.filter((call: any) => call.command === 'git_refresh'),
  ).toHaveLength(1);
  expect(calls.some((call: any) => call.command.startsWith('codex_'))).toBe(
    false,
  );
  await inspector.getByRole('button', { name: 'Close inspector' }).click();
  await expect(
    page.getByRole('button', { name: 'Show inspector' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Collapse explorer' }).click();
  await expect(
    page.getByRole('button', { name: 'Show explorer' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    // Reopening the explorer focuses its first control.
    page.getByRole('button', { name: 'New file', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Show inspector', exact: true }),
  ).toHaveCount(0);
});

test('empty task inspector distinguishes active work and opens the reported plan without changing mode', async ({
  page,
}) => {
  await proposedPlanFixture(page);
  const inspector = page.getByRole('complementary', {
    name: 'Changes inspector',
  });
  await inspector.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(inspector).toContainText('Waiting for file changes');
  await completePlan(page);
  await inspector.getByRole('button', { name: 'Task', exact: true }).click();
  await expect(inspector).toContainText('No file changes reported');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await inspector.getByRole('button', { name: 'Read proposed plan →' }).click();
  await expect(
    page.getByRole('article', { name: 'Proposed plan', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate(() =>
      (window as any).testCalls.filter(
        (call: any) => call.command === 'codex_start_turn',
      ),
    ),
  ).toHaveLength(1);
  await page.screenshot({
    path: 'test-results/screenshots/inspector-plan.png',
    animations: 'disabled',
  });
});

test('explorer creates files and folders inline, never overwrites, and opens new files for editing', async ({
  page,
}) => {
  await openProject(page);
  const explorerPane = page.getByRole('complementary', {
    name: 'Project explorer',
  });
  await explorerPane
    .getByRole('button', { name: 'New file', exact: true })
    .click();
  const name = explorerPane.getByRole('textbox', { name: 'New file name' });
  await expect(name).toBeFocused();
  await name.fill('notes.md');
  await name.press('Enter');
  await expect(
    explorerPane.getByRole('button', { name: 'notes.md' }),
  ).toBeVisible();
  await expect(page.locator('.file-toolbar')).toContainText('notes.md');
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  // A duplicate name is refused inline and the existing file is untouched.
  await explorerPane.getByRole('button', { name: 'src' }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: 'New file' }).click();
  const nested = explorerPane.getByRole('textbox', { name: 'New file name' });
  await nested.fill('main.ts');
  await nested.press('Enter');
  await expect(explorerPane.getByRole('alert')).toContainText('already exists');
  await expect(nested).toBeVisible();
  await nested.press('Escape');
  await expect(nested).toHaveCount(0);
  // Nested names create and reveal their folders.
  await explorerPane.getByRole('button', { name: 'New folder' }).click();
  const folder = explorerPane.getByRole('textbox', { name: 'New folder name' });
  await folder.fill('components/ui');
  await folder.press('Enter');
  await expect(
    explorerPane.getByRole('button', { name: 'ui', exact: true }),
  ).toBeVisible();
  const created = await page.evaluate(() =>
    (window as any).testCalls
      .filter((c: any) => c.command === 'file_create')
      .map((c: any) => c.args),
  );
  expect(created).toEqual([
    {
      parent: '',
      name: 'notes.md',
      directory: false,
      expectedProjectRoot: '/fixture/project',
    },
    {
      parent: 'src',
      name: 'main.ts',
      directory: false,
      expectedProjectRoot: '/fixture/project',
    },
    {
      parent: 'src',
      name: 'components/ui',
      directory: true,
      expectedProjectRoot: '/fixture/project',
    },
  ]);
});

test('explorer menu is keyboard operable and renames, copies, adds context, and trashes safely', async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(() => {
    const w = window as any;
    w.copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => w.copied.push(text) },
    });
  });
  const explorerPane = page.getByRole('complementary', {
    name: 'Project explorer',
  });
  const hello = explorerPane.getByRole('button', { name: 'hello.txt' });
  await hello.focus();
  await hello.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Actions for hello.txt' });
  await expect(
    menu.getByRole('menuitem', { name: 'Open', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    menu.getByRole('menuitem', { name: 'Open in default app' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(hello).toBeFocused();
  // Unsaved edits block renaming or trashing that file.
  await hello.click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill('unsaved change');
  await hello.focus();
  await hello.press('F2');
  await expect(page.getByRole('alert')).toContainText(
    'Save or discard your edits to hello.txt',
  );
  await expect(explorerPane.getByRole('textbox')).toHaveCount(0);
  // Clean files rename inline, refusing nothing but existing names.
  const readme = explorerPane.getByRole('button', { name: 'README.md' });
  await readme.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const rename = explorerPane.getByRole('textbox', {
    name: 'Rename README.md',
  });
  await expect(rename).toHaveValue('README.md');
  await rename.fill('GUIDE.md');
  await rename.press('Enter');
  await expect(
    explorerPane.getByRole('button', { name: 'GUIDE.md' }),
  ).toBeVisible();
  await expect(
    explorerPane.getByRole('button', { name: 'README.md' }),
  ).toHaveCount(0);
  const guide = explorerPane.getByRole('button', { name: 'GUIDE.md' });
  await guide.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy relative path' }).click();
  expect(await page.evaluate(() => (window as any).copied)).toEqual([
    'GUIDE.md',
  ]);
  await explorerPane
    .getByRole('button', { name: 'src' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to chat' }).click();
  await expect(
    page.getByRole('button', { name: 'Preview context src' }),
  ).toBeVisible();
  // Trash asks first and can be cancelled.
  await guide.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('Move ‘GUIDE.md’ to the Trash?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(guide).toBeVisible();
  await guide.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Move to Trash' })
    .click();
  await expect(guide).toHaveCount(0);
  const trashed = await page.evaluate(() =>
    (window as any).testCalls
      .filter((c: any) => c.command === 'file_trash')
      .map((c: any) => c.args.relativePath),
  );
  expect(trashed).toEqual(['GUIDE.md']);
});
