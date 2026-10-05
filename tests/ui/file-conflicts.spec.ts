import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { concurrentFixture, mockDesktop, openProject } from './fixtures';

const localText = 'My important unsaved work';
const diskText = 'A different version on disk';
const review = (page: Page) =>
  page.getByRole('region', { name: 'File conflict comparison', exact: true });
const saveButton = (page: Page) =>
  page.locator('.file-toolbar').getByRole('button', { name: /^Save/ });
const fileTab = (page: Page, path = 'hello.txt') =>
  page.locator('.file-tabs').getByRole('button', {
    name: new RegExp(`^${path.split('/').at(-1)!.replaceAll('.', '\\.')} ●$`),
  });

async function calls(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window as any).testAgentCalls.filter(
        (call: any) => call.command === name,
      ),
    command,
  );
}

async function changeDisk(page: Page, text: string, path = 'hello.txt') {
  await page.evaluate(
    ({ path, text }) => (window as any).testDiskChange(path, text),
    { path, text },
  );
}

async function editFile(page: Page, text = localText) {
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'hello.txt', exact: true })
    .click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.cm-content').fill(text);
}

async function conflict(page: Page, text = localText, disk = diskText) {
  await openProject(page);
  await editFile(page, text);
  await changeDisk(page, disk);
  await saveButton(page).click();
  await expect(page.locator('.banner.warning')).toContainText(
    'CONFLICT: File changed on disk',
  );
  await expect(fileTab(page)).toBeVisible();
}

async function compare(page: Page) {
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(review(page)).toBeVisible();
}

async function confirmSave(page: Page) {
  await review(page)
    .getByRole('button', { name: 'Save my version…', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Save your version?' });
  await expect(dialog).toContainText('hello.txt');
  await dialog
    .getByRole('button', { name: 'Save my version', exact: true })
    .click();
}

async function expectUnsaved(page: Page, text = localText) {
  await expect(fileTab(page)).toBeVisible();
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
  await expect(page.locator('.cm-content')).toContainText(text);
}

// Delay delivery, not the native operation: saves have reached disk and reads
// retain the snapshot from when they were requested. This models delayed IPC
// acknowledgements without changing the shared fixture's semantics.
async function holdReplies(page: Page, command: 'file_read' | 'file_save') {
  await page.evaluate((heldCommand) => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.conflictHeldReplies = [];
    w.conflictHold = true;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      const hold =
        w.conflictHold &&
        command === heldCommand &&
        args.relativePath === 'hello.txt';
      const result = await invoke(command, args);
      if (!hold) return result;
      return new Promise((resolve, reject) => {
        w.conflictHeldReplies.push({ result, resolve, reject });
      });
    };
  }, command);
}

async function pendingReplies(page: Page, count: number) {
  await expect
    .poll(() => page.evaluate(() => (window as any).conflictHeldReplies.length))
    .toBe(count);
}

async function releaseReply(page: Page, index = 0, error = '') {
  await page.evaluate(
    ({ index, error }) => {
      const reply = (window as any).conflictHeldReplies[index];
      if (error) reply.reject(new Error(error));
      else reply.resolve(reply.result);
      return new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    },
    { index, error },
  );
}

async function stopHolding(page: Page) {
  await page.evaluate(() => ((window as any).conflictHold = false));
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
});

test('comparison is explicit, names both versions, and stays idle without disk polling', async ({
  page,
}) => {
  await conflict(page);
  const reads = (await calls(page, 'file_read')).length;
  const stats = (await calls(page, 'file_stat')).length;
  await page.clock.install();
  await page.clock.fastForward(60_000);
  expect(await calls(page, 'file_read')).toHaveLength(reads);
  await expect(review(page)).toHaveCount(0);

  await compare(page);
  await expect(review(page)).toContainText('hello.txt');
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toBeHidden();
  await expect(
    review(page).getByRole('heading', { name: 'Your unsaved content' }),
  ).toBeVisible();
  await expect(
    review(page).getByRole('heading', { name: 'Current disk content' }),
  ).toBeVisible();
  await expect(review(page).locator('pre').nth(0)).toHaveText(localText);
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await page.clock.fastForward(60_000);
  expect(await calls(page, 'file_read')).toHaveLength(reads + 1);
  expect(await calls(page, 'file_stat')).toHaveLength(stats);
  expect(await calls(page, 'file_save')).toHaveLength(1);

  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  await expectUnsaved(page);
  await expect(page.locator('.banner.warning')).toBeVisible();
  expect(await calls(page, 'file_save')).toHaveLength(1);
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expectUnsaved(page, 'before');
  await expect(page.locator('.cm-content')).not.toContainText(localText);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expectUnsaved(page);
});

test('saving the reviewed version requires confirmation and the exact compared fingerprint', async ({
  page,
}) => {
  await conflict(page);
  await compare(page);
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await review(page)
    .getByRole('button', { name: 'Save my version…', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Save your version?' });
  await expect(dialog).toContainText('hello.txt');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await calls(page, 'file_save')).toHaveLength(1);
  await expect(review(page).locator('pre').nth(0)).toHaveText(localText);
  await expect(fileTab(page)).toBeVisible();

  await confirmSave(page);
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  await expect(page.locator('.cm-content')).toContainText(localText);
  await expect(page.locator('.banner.warning')).toHaveCount(0);
  const saves = await calls(page, 'file_save');
  expect(saves).toHaveLength(2);
  expect(saves[1].args).toEqual({
    relativePath: 'hello.txt',
    expectedFingerprint: {
      sizeBytes: diskText.length,
      modifiedNanos: 2,
      hash: diskText,
    },
    content: localText,
  });
  expect(await calls(page, 'agent_set_permissions')).toHaveLength(0);
  expect(await calls(page, 'agent_update_thread_settings')).toHaveLength(0);
});

test('a second disk change refuses replacement until it has been refreshed and reviewed', async ({
  page,
}) => {
  await conflict(page);
  await compare(page);
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await changeDisk(page, 'An even newer disk version');
  await confirmSave(page);
  await expect(review(page)).toContainText('CONFLICT');
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await expect(review(page).locator('pre').nth(0)).toHaveText(localText);
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await expect(fileTab(page)).toBeVisible();
  const rejectedSave = (await calls(page, 'file_save')).at(-1);
  expect(rejectedSave.args.expectedFingerprint.hash).toBe(diskText);

  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await expect(review(page).locator('pre').nth(1)).toHaveText(
    'An even newer disk version',
  );
  await confirmSave(page);
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  expect((await calls(page, 'file_save')).at(-1).args).toMatchObject({
    content: localText,
    expectedFingerprint: { hash: 'An even newer disk version' },
  });
});

test('comparison retries reject unreadable or mismatched file responses without losing local work', async ({
  page,
}) => {
  await conflict(page);
  await page.evaluate(() => {
    let reads = 0;
    (window as any).testAgentInvoke = (command: string) => {
      if (command !== 'file_read') return;
      if (++reads === 1)
        throw new Error('Permission denied while reading hello.txt');
      if (reads === 2)
        return {
          path: 'README.md',
          content: 'Wrong file contents must not appear',
          encoding: 'utf8',
          newline: 'lf',
          sizeBytes: 35,
          fingerprint: { hash: 'wrong-file', modifiedNanos: 50, sizeBytes: 35 },
          readOnlyRecommended: false,
        };
    };
  });
  await compare(page);
  await expect(review(page)).toContainText('Permission denied');
  await expect(review(page).locator('pre').first()).toHaveText(localText);
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await expect(fileTab(page)).toBeVisible();
  const reads = (await calls(page, 'file_read')).length;
  await page.clock.install();
  await page.clock.fastForward(60_000);
  expect(await calls(page, 'file_read')).toHaveLength(reads);
  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await expect(review(page)).toContainText(/another file|match this tab/i);
  await expect(review(page)).not.toContainText('Wrong file contents');
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await expect(review(page)).not.toContainText('Permission denied');
  expect(await calls(page, 'file_save')).toHaveLength(1);
  await review(page).getByRole('button', { name: 'Close comparison' }).click();
  await expectUnsaved(page);
});

test('closing a loading comparison prevents a late failure from reopening or poisoning its replacement', async ({
  page,
}) => {
  await conflict(page);
  await holdReplies(page, 'file_read');
  await compare(page);
  await pendingReplies(page, 1);
  await expect(review(page)).toContainText(/Loading/i);
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await review(page).getByRole('button', { name: 'Close comparison' }).click();
  await expect(review(page)).toHaveCount(0);
  await expectUnsaved(page);

  await stopHolding(page);
  await changeDisk(page, 'Freshly reopened disk version');
  await compare(page);
  await expect(review(page).locator('pre').nth(1)).toHaveText(
    'Freshly reopened disk version',
  );
  await releaseReply(page, 0, 'Obsolete read failed');
  await expect(review(page).locator('pre').nth(1)).toHaveText(
    'Freshly reopened disk version',
  );
  await expect(page.locator('.file-workspace')).not.toContainText(
    'Obsolete read failed',
  );
});

test('switching files and reopening a tab never displays another tab’s delayed comparison', async ({
  page,
}) => {
  await conflict(page);
  await holdReplies(page, 'file_read');
  await compare(page);
  await pendingReplies(page, 1);
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'README.md', exact: true })
    .click();
  await expect(page.locator('.file-toolbar')).toContainText('README.md');
  await expect(review(page)).toHaveCount(0);
  await releaseReply(page);
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('Hello Workbench');
  await fileTab(page).click();
  await expectUnsaved(page);
  await expect(review(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await page.getByRole('button', { name: 'Don’t Save', exact: true }).click();
  await stopHolding(page);
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'hello.txt', exact: true })
    .click();
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText(diskText);
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
});

test('the newest refresh wins even when older disk snapshots arrive afterward', async ({
  page,
}) => {
  await conflict(page);
  await compare(page);
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await holdReplies(page, 'file_read');
  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await pendingReplies(page, 1);
  await changeDisk(page, 'Newest explicitly requested version');
  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await pendingReplies(page, 2);
  await releaseReply(page, 1);
  await expect(review(page).locator('pre').nth(1)).toHaveText(
    'Newest explicitly requested version',
  );
  await releaseReply(page, 0);
  await expect(review(page).locator('pre').nth(1)).toHaveText(
    'Newest explicitly requested version',
  );
  await expect(review(page).locator('pre').nth(0)).toHaveText(localText);
  await expect(review(page)).not.toContainText(/Loading/i);
  expect(await calls(page, 'file_save')).toHaveLength(1);
});

test('reload cancellation keeps local work and confirmed reload alone discards it', async ({
  page,
}) => {
  await conflict(page);
  const reads = (await calls(page, 'file_read')).length;
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reload disk version?' });
  await expect(dialog).toContainText('hello.txt');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectUnsaved(page);
  expect(await calls(page, 'file_read')).toHaveLength(reads);
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await dialog.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(diskText);
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  await expect(fileTab(page)).toHaveCount(0);
  await expect(page.locator('.banner.warning')).toHaveCount(0);
  expect(await calls(page, 'file_save')).toHaveLength(1);
});

for (const failure of ['missing', 'permission', 'binary', 'too large']) {
  test(`a ${failure} disk version cannot destroy unsaved work through compare or reload`, async ({
    page,
  }) => {
    await conflict(page);
    await page.evaluate((failure) => {
      (window as any).testAgentInvoke = (command: string, args: any) => {
        if (command !== 'file_read' || args.relativePath !== 'hello.txt')
          return;
        if (failure === 'missing') throw new Error('File missing');
        if (failure === 'permission') throw new Error('Permission denied');
        return {
          path: 'hello.txt',
          content: null,
          encoding: failure === 'binary' ? 'binary' : 'unsupported',
          sizeBytes: 6 * 1024 * 1024,
          newline: 'unknown',
          fingerprint: {
            hash: 'unpreviewable-data',
            modifiedNanos: 77,
            sizeBytes: 6 * 1024 * 1024,
          },
          readOnlyRecommended: true,
        };
      };
    }, failure);
    await compare(page);
    await expect(review(page)).toContainText(
      failure === 'missing'
        ? /missing/i
        : failure === 'permission'
          ? /permission denied/i
          : failure === 'binary'
            ? /binary/i
            : /large|preview/i,
    );
    await expect(review(page).locator('pre').first()).toHaveText(localText);
    await expect(
      review(page).getByRole('button', { name: 'Save my version…' }),
    ).toBeDisabled();
    await review(page)
      .getByRole('button', { name: 'Close comparison' })
      .click();
    await page
      .getByRole('button', { name: 'Reload disk', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Reload disk version?' })
      .getByRole('button', { name: 'Reload', exact: true })
      .click();
    await expectUnsaved(page);
    await expect(page.locator('.banner.warning')).toBeVisible();
    expect(await calls(page, 'file_save')).toHaveLength(1);
    await expect(saveButton(page)).toBeEnabled();
  });
}

test('edits typed while a confirmed reload is pending survive its late reply', async ({
  page,
}) => {
  await conflict(page);
  await holdReplies(page, 'file_read');
  await page.getByRole('button', { name: 'Reload disk', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reload disk version?' })
    .getByRole('button', { name: 'Reload', exact: true })
    .click();
  await pendingReplies(page, 1);
  await page.locator('.cm-content').fill('New edits made after confirming');
  await releaseReply(page);
  await expectUnsaved(page, 'New edits made after confirming');
  await expect(page.locator('.banner.warning')).toBeVisible();
  expect(await calls(page, 'file_save')).toHaveLength(1);
});

test('repeated Save coalesces and typing during its acknowledgement stays dirty', async ({
  page,
}) => {
  await openProject(page);
  await editFile(page, 'The version submitted first');
  await holdReplies(page, 'file_save');
  await saveButton(page).click();
  await pendingReplies(page, 1);
  await page.keyboard.press('Meta+s');
  await page.keyboard.press('Meta+s');
  expect(await calls(page, 'file_save')).toHaveLength(1);
  await page.locator('.cm-content').fill('New work typed while saving');
  await releaseReply(page);
  await expectUnsaved(page, 'New work typed while saving');
  await stopHolding(page);
  await saveButton(page).click();
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  const saves = await calls(page, 'file_save');
  expect(saves).toHaveLength(2);
  expect(saves[0].args.content).toBe('The version submitted first');
  expect(saves[1].args.content).toBe('New work typed while saving');
  expect(saves[1].args.expectedFingerprint.hash).toBe(
    'The version submitted first',
  );
});

test('Save from a dirty-tab close cannot close over edits made during the write', async ({
  page,
}) => {
  await openProject(page);
  await editFile(page, 'Version saved by close');
  await holdReplies(page, 'file_save');
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await pendingReplies(page, 1);
  await page.locator('.cm-content').fill('Still working; do not close this');
  await releaseReply(page);
  await expectUnsaved(page, 'Still working; do not close this');
  expect(await calls(page, 'file_save')).toHaveLength(1);
  await stopHolding(page);
  await page.getByRole('button', { name: 'Close hello.txt' }).click();
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Close hello.txt' }),
  ).toHaveCount(0);
  expect((await calls(page, 'file_save')).at(-1).args.content).toBe(
    'Still working; do not close this',
  );
});

test('reviewed saves preserve CRLF while showing normalized readable text', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      const result = await invoke(command, args);
      if (
        (command === 'file_read' || command === 'file_save') &&
        args.relativePath === 'hello.txt'
      )
        return { ...result, newline: 'crlf' };
      return result;
    };
    w.testDiskChange('hello.txt', 'Original Windows line\r\n');
  });
  await conflict(page, 'My first line\nMy second line', 'Disk line\r\n');
  await compare(page);
  await expect(review(page).locator('pre').nth(0)).toHaveText(
    'My first line\nMy second line',
  );
  expect(await review(page).locator('pre').nth(1).textContent()).toBe(
    'Disk line\n',
  );
  await confirmSave(page);
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  expect((await calls(page, 'file_save')).at(-1).args).toMatchObject({
    expectedFingerprint: { hash: 'Disk line\r\n' },
    content: 'My first line\r\nMy second line',
  });
  await expect(page.locator('.file-status')).toContainText('CRLF');
});

test('bounded previews explain truncation, disable replacement, and copy the full local buffer', async ({
  page,
}) => {
  const local = 'L'.repeat(70_000) + '\nLOCAL END';
  const disk = 'D'.repeat(70_000) + '\nDISK END';
  await conflict(page, local, disk);
  await page.evaluate(() => {
    const w = window as any;
    w.conflictCopied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (w.conflictClipboardDenied) throw new Error('Clipboard denied');
          w.conflictCopied.push(text);
        },
      },
    });
  });
  await compare(page);
  const previews = review(page).locator('pre');
  await expect(previews).toHaveCount(2);
  const lengths = await previews.evaluateAll((nodes) =>
    nodes.map((node) => node.textContent!.length),
  );
  expect(lengths).toEqual([65_536, 65_536]);
  await expect(review(page)).toContainText(/limited to 65,?536 characters/i);
  await expect(review(page)).not.toContainText('LOCAL END');
  await expect(review(page)).not.toContainText('DISK END');
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await page.evaluate(() => ((window as any).conflictClipboardDenied = true));
  await review(page).getByRole('button', { name: 'Copy my text' }).click();
  await expect(review(page)).toContainText(/Clipboard denied|could not copy/i);
  await page.evaluate(() => ((window as any).conflictClipboardDenied = false));
  await review(page).getByRole('button', { name: 'Copy my text' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).conflictCopied))
    .toEqual([local]);
  await expect(fileTab(page)).toBeVisible();
  // Either incomplete side independently prevents a destructive save. Once
  // both fit, an explicit refresh makes the reviewed action available again.
  await changeDisk(page, 'Short disk version');
  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await expect(previews.nth(1)).toHaveText('Short disk version');
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await review(page).getByRole('button', { name: 'Close comparison' }).click();
  await page.locator('.cm-content').fill('Short local version');
  await changeDisk(page, disk);
  await compare(page);
  await expect(previews.nth(0)).toHaveText('Short local version');
  await expect(previews.nth(1)).toHaveText('D'.repeat(65_536));
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeDisabled();
  await changeDisk(page, 'Fully reviewable disk version');
  await review(page).getByRole('button', { name: 'Refresh disk' }).click();
  await expect(previews.nth(1)).toHaveText('Fully reviewable disk version');
  await expect(
    review(page).getByRole('button', { name: 'Save my version…' }),
  ).toBeEnabled();
  await expect(review(page)).not.toContainText('Preview limited');
  expect(await calls(page, 'file_save')).toHaveLength(1);
});

test('comparison stays bounded and keyboard accessible in both themes with a generic agent warning', async ({
  page,
}) => {
  await concurrentFixture(page);
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Keep working');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop', exact: true }),
  ).toBeVisible();
  await editFile(page);
  const warning = page.locator('.file-workspace .banner').filter({
    hasText: /is working and may modify this file/,
  });
  await expect(warning).toContainText(/agent/i);
  await expect(warning).not.toContainText('Codex');
  await changeDisk(page, diskText);
  await saveButton(page).click();
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const trigger = page.getByRole('button', { name: 'Compare', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
  await expect(
    review(page).getByRole('heading', { name: 'hello.txt', exact: true }),
  ).toBeFocused();
  const keyboardOrder = [
    review(page).getByRole('button', { name: 'Close comparison', exact: true }),
    review(page).getByRole('button', { name: 'Refresh disk', exact: true }),
    review(page).getByRole('button', { name: 'Copy my text', exact: true }),
    review(page).getByRole('textbox', {
      name: 'Your unsaved text',
      exact: true,
    }),
    review(page).getByRole('textbox', {
      name: 'Compared disk text',
      exact: true,
    }),
    review(page).getByRole('button', { name: 'Keep editing', exact: true }),
    review(page).getByRole('button', { name: 'Reload disk', exact: true }),
    review(page).getByRole('button', { name: 'Save my version…', exact: true }),
  ];
  for (const control of keyboardOrder) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    if ((await control.getAttribute('role')) === 'textbox') {
      await expect(control).toHaveAttribute('aria-readonly', 'true');
      await page.keyboard.press('ArrowDown');
    }
  }
  for (let index = 1; index < keyboardOrder.length; index++)
    await page.keyboard.press('Shift+Tab');
  await expect(keyboardOrder[0]).toBeFocused();
  for (const appearance of ['dark', 'light']) {
    await page.evaluate(
      (appearance) =>
        (document.documentElement.dataset.appearance = appearance),
      appearance,
    );
    const geometry = await review(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const workspace = element
        .closest('.file-workspace')!
        .getBoundingClientRect();
      return {
        inside:
          rect.left >= workspace.left && rect.right <= workspace.right + 1,
        bounded: rect.bottom <= workspace.bottom + 1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(geometry).toEqual({
      inside: true,
      bounded: true,
      pageOverflow: false,
    });
    for (const name of ['Refresh disk', 'Copy my text', 'Close comparison']) {
      const control = review(page).getByRole('button', { name, exact: true });
      await expect(control).toBeInViewport();
    }
    if (process.env.WORKBENCH_AXE_PATH) {
      await page.evaluate(readFileSync(process.env.WORKBENCH_AXE_PATH, 'utf8'));
      const violations = await page.evaluate(async () =>
        (
          await (window as any).axe.run(document.querySelector('.compare'), {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          })
        ).violations.map((violation: any) => ({
          id: violation.id,
          targets: violation.nodes.map((node: any) => node.target),
        })),
      );
      expect(violations).toEqual([]);
    }
    await page.screenshot({
      path: `test-results/screenshots/file-conflict-${appearance}.png`,
      animations: 'disabled',
    });
  }
  await expect(keyboardOrder[0]).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(review(page)).toHaveCount(0);
  await expectUnsaved(page);
  await expect(page.locator('.cm-content')).toBeFocused();
});

for (const mode of ['ordinary', 'compared']) {
  test(`an uncertain ${mode} save cannot evict edits equal to the old disk baseline`, async ({
    page,
  }) => {
    const original = 'before\n';
    if (mode === 'ordinary') {
      await openProject(page);
      await editFile(page);
    } else {
      await conflict(page);
      await compare(page);
      await expect(review(page).locator('pre').nth(1)).toHaveText(diskText);
    }
    await holdReplies(page, 'file_save');
    if (mode === 'ordinary') await saveButton(page).click();
    else await confirmSave(page);
    await pendingReplies(page, 1);
    if (mode === 'compared')
      await review(page)
        .getByRole('button', { name: 'Close comparison' })
        .click();
    // The native write has already landed, but its acknowledgement is pending.
    // Matching the old baseline must not make these newer edits disposable.
    await page.locator('.cm-content').fill(original);
    if (mode === 'ordinary')
      await releaseReply(page, 0, 'Native save acknowledgement was lost');
    else {
      await page.evaluate(() => {
        const reply = (window as any).conflictHeldReplies[0];
        reply.result = { ...reply.result, path: 'README.md' };
      });
      await releaseReply(page);
    }
    await expectUnsaved(page, 'before');
    await expect(page.locator('.banner.warning')).toContainText(
      mode === 'ordinary' ? /acknowledgement was lost/ : /did not match/i,
    );
    await stopHolding(page);
    expect(
      await page.evaluate(
        async () =>
          (
            await (window as any).__TAURI_INTERNALS__.invoke('file_read', {
              relativePath: 'hello.txt',
            })
          ).content,
      ),
    ).toBe(localText);
    await page
      .getByRole('complementary', { name: 'Project explorer' })
      .getByRole('button', { name: 'README.md', exact: true })
      .click();
    await expect(page.locator('.file-toolbar')).toContainText('README.md');
    await fileTab(page).click();
    await expectUnsaved(page, 'before');
    await expect(page.locator('.banner.warning')).toBeVisible();
    await page.locator('.cm-content').fill('Another edit after the failure');
    await page.locator('.cm-content').fill(original);
    await expectUnsaved(page, 'before');
    await expect(page.locator('.banner.warning')).toBeVisible();
    expect(await calls(page, 'file_save')).toHaveLength(
      mode === 'ordinary' ? 1 : 2,
    );
  });
}

test('switching projects clears pending file state and ignores an old project’s late read', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any;
    w.testRecentProjects = ['/fixture/another-project'];
    w.testAgentInvoke = (command: string, args: any) => {
      if (
        command === 'project_open' &&
        args.path === '/fixture/another-project'
      ) {
        w.conflictOtherProject = true;
        return {
          root: '/fixture/another-project',
          displayName: 'another-project',
          git: {
            available: true,
            branch: 'main',
            head: 'other-project',
            files: [],
            unstaged: '',
            staged: '',
            truncated: false,
          },
        };
      }
      if (
        command === 'file_read' &&
        args.relativePath === 'hello.txt' &&
        w.conflictOtherProject
      )
        return {
          path: 'hello.txt',
          content: 'Text belonging only to the new project',
          encoding: 'utf8',
          newline: 'lf',
          sizeBytes: 38,
          fingerprint: { hash: 'new-project', modifiedNanos: 1, sizeBytes: 38 },
          readOnlyRecommended: false,
        };
    };
  });
  await openProject(page);
  await changeDisk(page, 'Text belonging only to the old project');
  await holdReplies(page, 'file_read');
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'hello.txt', exact: true })
    .click();
  await pendingReplies(page, 1);
  await page.locator('.project-button').click();
  await page
    .getByRole('option')
    .filter({ hasText: '/fixture/another-project' })
    .click();
  await expect(page.locator('.project-button')).toContainText(
    'another-project',
  );
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A closer look at your code' }),
  ).toBeVisible();
  await expect(page.locator('.file-workspace')).not.toContainText(
    'Loading file',
  );
  await expect(page.locator('.file-tabs button')).toHaveCount(0);
  await stopHolding(page);
  await page
    .getByRole('complementary', { name: 'Project explorer' })
    .getByRole('button', { name: 'hello.txt', exact: true })
    .click();
  await expect(page.locator('.cm-content')).toContainText(
    'Text belonging only to the new project',
  );
  await releaseReply(page);
  await expect(page.locator('.cm-content')).toContainText(
    'Text belonging only to the new project',
  );
  await expect(page.locator('.file-workspace')).not.toContainText(
    'Text belonging only to the old project',
  );
  await expect(page.locator('.file-workspace .banner.error')).toHaveCount(0);
  await expect(page.locator('.file-workspace')).not.toContainText(
    'Loading file',
  );
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  expect(await calls(page, 'file_save')).toHaveLength(0);
});

test('a pending project switch pauses editing and shortcuts, then restores the old editor on failure', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any;
    w.testRecentProjects = ['/fixture/unavailable-project'];
    w.testAgentInvoke = (command: string, args: any) => {
      if (
        command === 'project_open' &&
        args.path === '/fixture/unavailable-project'
      )
        return new Promise((_resolve, reject) => {
          w.conflictRejectProjectOpen = reject;
        });
    };
  });
  await openProject(page);
  await editFile(page, 'Saved text in the original project');
  await saveButton(page).click();
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  await page.locator('.project-button').click();
  await page
    .getByRole('option')
    .filter({ hasText: '/fixture/unavailable-project' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).conflictRejectProjectOpen),
    )
    .toBe('function');
  await expect(page.locator('.work-area')).toHaveAttribute('inert', '');
  await expect(
    page.getByRole('status').filter({ hasText: 'Opening your project…' }),
  ).toContainText('Editing is paused until it is ready');
  await expect(
    page.getByRole('button', { name: 'New task', exact: true }),
  ).toBeDisabled();
  const stats = (await calls(page, 'file_stat')).length;
  // Even an attempted focus cannot put keyboard input into an inert editor.
  await page
    .locator('.cm-content')
    .evaluate((element) => (element as HTMLElement).focus());
  await expect(page.locator('.cm-content')).not.toBeFocused();
  await page.keyboard.type('This must not enter the old buffer');
  await page.keyboard.press('Meta+s');
  await page.keyboard.press('Meta+w');
  await page.keyboard.press('Meta+p');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.cm-content')).toContainText(
    'Saved text in the original project',
  );
  await expect(page.locator('.cm-content')).not.toContainText('must not enter');
  await expect(
    page.locator('.file-tabs button[aria-label="Close hello.txt"]'),
  ).toHaveCount(1);
  await expect(
    page.getByRole('dialog', { name: 'Jump to anything' }),
  ).toHaveCount(0);
  expect(await calls(page, 'file_save')).toHaveLength(1);
  expect(await calls(page, 'file_stat')).toHaveLength(stats);
  await page.evaluate(() =>
    (window as any).conflictRejectProjectOpen(
      new Error('The new project is unavailable'),
    ),
  );
  await expect(page.getByRole('alert')).toContainText(
    'The new project is unavailable',
  );
  await expect(page.locator('.work-area')).not.toHaveAttribute('inert');
  await expect(page.locator('.project-button')).toContainText(
    'fixture-project',
  );
  await expect(
    page.getByRole('button', { name: 'New task', exact: true }),
  ).toBeEnabled();
  await page.locator('.cm-content').fill('Editing works again after failure');
  await expectUnsaved(page, 'Editing works again after failure');
  await saveButton(page).click();
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  expect((await calls(page, 'file_save')).at(-1).args.content).toBe(
    'Editing works again after failure',
  );
});
