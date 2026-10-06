import { test, expect, type Page } from '@playwright/test';
import { mockDesktop, openProject } from './fixtures';

const projectRoot = '/fixture/project';
const otherProject = '/work/another-project';
const unsavedText = 'Unrelated work that must survive file actions';
const explorer = (page: Page) =>
  page.getByRole('complementary', { name: 'Project explorer' });
const row = (page: Page, name: string) =>
  explorer(page).getByRole('button', { name, exact: true });
const toolbar = (page: Page) => page.locator('.file-toolbar');
const save = (page: Page) =>
  toolbar(page).getByRole('button', { name: /^Save/ });
const close = (page: Page, path: string) =>
  page.locator('.file-tabs').getByRole('button', { name: `Close ${path}` });

async function calls(page: Page, command: string) {
  return page.evaluate(
    (command) =>
      (window as any).explorerCalls.filter(
        (call: any) => call.command === command,
      ),
    command,
  );
}

// These gates are local to this suite. A before gate can fail without changing
// disk; an after gate retains the actual native result, including read snapshots.
async function installNativeGates(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    const native = async (command: string, args: any) => {
      const result = await invoke(command, args);
      // The shared fixture has one project. Give successful transitions their
      // actual requested identity so cross-project scope assertions are real.
      return command === 'project_open'
        ? {
            ...result,
            root: args.path,
            displayName: args.path.split('/').at(-1),
          }
        : result;
    };
    w.explorerCalls = [];
    w.explorerPending = [];
    w.explorerHold = null;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
      w.explorerCalls.push({ command, args });
      const gate = w.explorerHold;
      if (
        !gate ||
        gate.command !== command ||
        (gate.path !== undefined && gate.path !== args.relativePath)
      )
        return native(command, args);
      const result = gate.after ? await native(command, args) : undefined;
      return new Promise((resolve, reject) => {
        w.explorerPending.push({
          command,
          args,
          reject,
          complete: () =>
            gate.after
              ? resolve(result)
              : native(command, args).then(resolve, reject),
        });
      });
    };
  });
}

async function hold(page: Page, command: string, path?: string, after = false) {
  await page.evaluate(
    (gate) => {
      const w = window as any;
      w.explorerHold = gate;
      w.explorerPending = [];
    },
    { command, path, after },
  );
}

async function pending(page: Page, count = 1) {
  await expect
    .poll(() => page.evaluate(() => (window as any).explorerPending.length))
    .toBe(count);
}

async function release(page: Page, error = '', index = 0) {
  await page.evaluate(
    ({ error, index }) => {
      const w = window as any;
      w.explorerHold = null;
      const reply = w.explorerPending[index];
      if (error) reply.reject(new Error(error));
      else reply.complete();
      return new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    },
    { error, index },
  );
}

async function openFile(page: Page, name: string) {
  await row(page, name).click();
  await expect(toolbar(page)).toContainText(name);
  await expect(page.locator('.cm-content')).toBeVisible();
}

async function editFile(page: Page, name: string, content?: string) {
  await openFile(page, name);
  await toolbar(page)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  if (content !== undefined) await page.locator('.cm-content').fill(content);
}

async function rename(page: Page, name: string, next: string) {
  await row(page, name).focus();
  await row(page, name).press('F2');
  const field = explorer(page).getByRole('textbox', { name: `Rename ${name}` });
  await expect(field).toBeFocused();
  await field.fill(next);
  await field.press('Enter');
  return field;
}

async function askTrash(page: Page, name: string) {
  await row(page, name).click({ button: 'right' });
  await page
    .getByRole('menu', { name: `Actions for ${name}` })
    .getByRole('menuitem', { name: /^Move to Trash/ })
    .click();
  const dialog = page.getByRole('dialog', {
    name: `Move ‘${name}’ to the Trash?`,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function trash(page: Page, name: string) {
  const dialog = await askTrash(page, name);
  await dialog
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click();
}

async function expectUnsaved(page: Page, path: string, text = unsavedText) {
  await page
    .locator('.file-tabs button')
    .filter({ hasText: `${path} ●` })
    .click();
  await expect(page.locator('.cm-content')).toContainText(text);
  await expect(page.locator('.file-status')).toContainText('Unsaved changes');
  await expect(save(page)).toBeEnabled();
}

async function chooseOtherProject(page: Page) {
  await page.locator('.project-button').click();
  const picker = page.getByRole('dialog', { name: 'Switch project' });
  await picker.getByRole('option').filter({ hasText: otherProject }).click();
}

test.beforeEach(async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.evaluate(
    (path) => ((window as any).testRecentProjects = [path]),
    otherProject,
  );
  await openProject(page);
  await installNativeGates(page);
});

test('create submits the exact project and path once across Enter and blur, and Cancel creates nothing', async ({
  page,
}) => {
  await explorer(page)
    .getByRole('button', { name: 'New file', exact: true })
    .click();
  const field = explorer(page).getByRole('textbox', { name: 'New file name' });
  await expect(field).toBeFocused();
  await field.fill('cancelled.txt');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  expect(await calls(page, 'file_create')).toHaveLength(0);

  await hold(page, 'file_create');
  await explorer(page)
    .getByRole('button', { name: 'New file', exact: true })
    .click();
  await field.fill('notes/today.txt');
  // Deliver the event sequence together, before disabled rendering can hide
  // duplicate submission bugs on either Chromium or WebKit.
  await field.evaluate((input) => {
    for (let index = 0; index < 2; index++)
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    input.dispatchEvent(new FocusEvent('blur'));
  });
  await pending(page);
  await expect(field).toBeDisabled();
  expect(await calls(page, 'file_create')).toEqual([
    {
      command: 'file_create',
      args: {
        expectedProjectRoot: projectRoot,
        parent: '',
        name: 'notes/today.txt',
        directory: false,
      },
    },
  ]);
  await release(page);
  await expect(row(page, 'today.txt')).toBeVisible();
  await expect(toolbar(page)).toContainText('notes/today.txt');
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  await expect(field).toHaveCount(0);
  await expect(
    explorer(page).getByRole('button', { name: 'New file', exact: true }),
  ).toBeEnabled();
});

test('create failure keeps its inline name and accessible error until a successful retry', async ({
  page,
}) => {
  await row(page, 'src').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  const field = explorer(page).getByRole('textbox', {
    name: 'New folder name',
  });
  await field.fill('nested/ui');
  await hold(page, 'file_create');
  await field.press('Enter');
  await pending(page);
  await release(page, 'Permission denied while creating this folder');
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('nested/ui');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(explorer(page).getByRole('alert')).toContainText(
    'Permission denied',
  );
  await expect(row(page, 'ui')).toHaveCount(0);
  await field.press('Enter');
  await expect(row(page, 'ui')).toBeVisible();
  await expect(field).toHaveCount(0);
  expect(
    (await calls(page, 'file_create')).map((call: any) => call.args),
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      expectedProjectRoot: projectRoot,
      parent: 'src',
      name: 'nested/ui',
      directory: true,
    })),
  );
});

test('rename blocks dirty descendants while unrelated dirty work survives clean-file rename and Trash', async ({
  page,
}) => {
  await editFile(page, 'hello.txt', unsavedText);
  await row(page, 'src').click();
  await editFile(page, 'main.ts', 'Unsaved source file');
  await row(page, 'src').press('F2');
  await expect(page.getByRole('alert')).toContainText('src/main.ts');
  await expect(explorer(page).getByRole('textbox')).toHaveCount(0);
  await row(page, 'src').press('ControlOrMeta+Backspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await calls(page, 'file_rename')).toHaveLength(0);
  expect(await calls(page, 'file_trash')).toHaveLength(0);
  await expectUnsaved(page, 'main.ts', 'Unsaved source file');

  await rename(page, 'README.md', 'GUIDE.md');
  await expect(row(page, 'GUIDE.md')).toBeVisible();
  await expectUnsaved(page, 'hello.txt');
  await trash(page, 'GUIDE.md');
  await expect(row(page, 'GUIDE.md')).toHaveCount(0);
  await expectUnsaved(page, 'main.ts', 'Unsaved source file');
  await expectUnsaved(page, 'hello.txt');
  expect(
    (await calls(page, 'file_rename')).map((call: any) => call.args),
  ).toEqual([
    {
      expectedProjectRoot: projectRoot,
      relativePath: 'README.md',
      name: 'GUIDE.md',
    },
  ]);
  expect(
    (await calls(page, 'file_trash')).map((call: any) => call.args),
  ).toEqual([{ expectedProjectRoot: projectRoot, relativePath: 'GUIDE.md' }]);
  expect(await calls(page, 'file_save')).toHaveLength(0);
});

for (const action of ['rename', 'trash'] as const) {
  test(`${action} reserves a clean editing buffer and releases it unchanged on failure`, async ({
    page,
  }) => {
    await editFile(page, 'hello.txt');
    await hold(page, `file_${action}`);
    if (action === 'rename') await rename(page, 'hello.txt', 'renamed.txt');
    else {
      const dialog = await askTrash(page, 'hello.txt');
      await dialog
        .getByRole('button', { name: 'Move to Trash', exact: true })
        .evaluate((button) => {
          (button as HTMLButtonElement).click();
          (button as HTMLButtonElement).click();
        });
    }
    await pending(page);
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await expect(close(page, 'hello.txt')).toBeDisabled();
    await expect(save(page)).toBeDisabled();
    await page.keyboard.press('ControlOrMeta+s');
    await page.keyboard.press('ControlOrMeta+s');
    expect(await calls(page, 'file_save')).toHaveLength(0);
    await expect(page.locator('.cm-content')).toContainText('before');
    await expect(
      explorer(page).getByRole('button', { name: 'New file', exact: true }),
    ).toBeDisabled();
    await expect(
      explorer(page).getByRole('button', { name: 'New folder', exact: true }),
    ).toBeDisabled();

    await release(page, `${action} failed: permission denied`);
    await expect(page.getByRole('alert')).toContainText('permission denied');
    await expect(close(page, 'hello.txt')).toBeEnabled();
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'true',
    );
    await expect(page.locator('.cm-content')).toContainText('before');
    await expect(page.locator('.file-status')).toContainText('Saved on disk');
    if (action === 'rename') {
      const field = explorer(page).getByRole('textbox', {
        name: 'Rename hello.txt',
      });
      await expect(field).toHaveValue('renamed.txt');
      await field.press('Enter');
      await expect(row(page, 'renamed.txt')).toBeVisible();
      await expect(toolbar(page)).toContainText('renamed.txt');
      await expect(page.locator('.cm-content')).toContainText('before');
    } else {
      await expect(row(page, 'hello.txt')).toBeVisible();
      await trash(page, 'hello.txt');
      await expect(row(page, 'hello.txt')).toHaveCount(0);
      await expect(close(page, 'hello.txt')).toHaveCount(0);
    }
    expect(await calls(page, `file_${action}`)).toHaveLength(2);
    expect(await calls(page, 'file_save')).toHaveLength(0);
  });

  test(`${action} reserves every open folder descendant, preserves sibling buffers, and mutates only that subtree`, async ({
    page,
  }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.testDiskChange('src/nested/child.ts', 'Child source\n');
      w.testDiskChange('src-other.txt', 'Sibling outside the folder\n');
    });
    await explorer(page)
      .getByRole('button', { name: 'Refresh file tree' })
      .click();
    await editFile(page, 'hello.txt', unsavedText);
    await row(page, 'src').click();
    await openFile(page, 'main.ts');
    await row(page, 'nested').click();
    await editFile(page, 'child.ts');
    await hold(page, `file_${action}`);
    if (action === 'rename') await rename(page, 'src', 'lib');
    else await trash(page, 'src');
    await pending(page);
    await expect(close(page, 'src/main.ts')).toBeDisabled();
    await expect(close(page, 'src/nested/child.ts')).toBeDisabled();
    await expect(close(page, 'hello.txt')).toBeEnabled();
    await expect(page.locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await expectUnsaved(page, 'hello.txt');
    await page
      .locator('.cm-content')
      .fill(`${unsavedText}; continued during mutation`);
    const reads = (await calls(page, 'file_read')).length;
    await row(page, 'main.ts').click();
    await expect(toolbar(page)).toContainText('hello.txt');
    await expect(page.locator('.cm-content')).toContainText(
      `${unsavedText}; continued during mutation`,
    );
    expect(await calls(page, 'file_read')).toHaveLength(reads);
    await release(page);
    await expect(row(page, 'src')).toHaveCount(0);
    await expect(row(page, 'src-other.txt')).toBeVisible();
    await expect(close(page, 'src/main.ts')).toHaveCount(0);
    await expect(close(page, 'src/nested/child.ts')).toHaveCount(0);
    await expectUnsaved(
      page,
      'hello.txt',
      `${unsavedText}; continued during mutation`,
    );
    if (action === 'rename') {
      await expect(row(page, 'lib')).toBeVisible();
      await expect(row(page, 'child.ts')).toBeVisible();
      await expect(close(page, 'lib/main.ts')).toBeEnabled();
      await expect(close(page, 'lib/nested/child.ts')).toBeEnabled();
      await openFile(page, 'child.ts');
      await expect(toolbar(page)).toContainText('lib/nested/child.ts');
      await expect(page.locator('.cm-content')).toContainText('Child source');
    }
    expect(
      (await calls(page, `file_${action}`)).map((call: any) => call.args),
    ).toEqual([
      {
        expectedProjectRoot: projectRoot,
        relativePath: 'src',
        ...(action === 'rename' ? { name: 'lib' } : {}),
      },
    ]);
    expect(await calls(page, 'file_save')).toHaveLength(0);
  });
}

test('Trash cancellation restores focus and never issues a native mutation', async ({
  page,
}) => {
  await editFile(page, 'hello.txt');
  await row(page, 'hello.txt').focus();
  await row(page, 'hello.txt').press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Actions for hello.txt' });
  await expect(
    menu.getByRole('menuitem', { name: 'Open', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    menu.getByRole('menuitem', { name: /^Move to Trash/ }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Move ‘hello.txt’ to the Trash?',
  });
  await expect(dialog).toContainText('restore');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row(page, 'hello.txt')).toBeFocused();
  await expect(close(page, 'hello.txt')).toBeEnabled();
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  expect(await calls(page, 'file_trash')).toHaveLength(0);
});

test('Trash rechecks the buffer after confirmation when an editor update was already queued', async ({
  page,
}) => {
  await editFile(page, 'hello.txt');
  const dialog = await askTrash(page, 'hello.txt');
  // A modal blocks fresh user input, but a queued editor update can still be
  // delivered after the initial clean-buffer check and before confirmation.
  await page.evaluate(async () => {
    const modulePath = '/src/lib/editor.svelte.ts';
    const { editContent } = await import(/* @vite-ignore */ modulePath);
    editContent('Queued unsaved work before Trash confirmation');
  });
  await dialog
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('hello.txt');
  await expect(row(page, 'hello.txt')).toBeVisible();
  await expectUnsaved(
    page,
    'hello.txt',
    'Queued unsaved work before Trash confirmation',
  );
  expect(await calls(page, 'file_trash')).toHaveLength(0);
});

test('a pending native rename rejects competing mutators and project switching without changing scope', async ({
  page,
}) => {
  await editFile(page, 'hello.txt');
  await hold(page, 'file_rename');
  const field = await rename(page, 'hello.txt', 'renamed.txt');
  await pending(page);
  // Queued key and blur callbacks must also observe the reservation.
  await field.evaluate((input) => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    input.dispatchEvent(new FocusEvent('blur'));
  });
  await row(page, 'README.md').press('F2');
  await row(page, 'README.md').press('ControlOrMeta+Backspace');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(explorer(page).getByRole('textbox')).toHaveCount(1);
  await expect(field).toHaveValue('renamed.txt');
  await page.keyboard.press('ControlOrMeta+o');
  expect(await calls(page, 'project_open')).toHaveLength(0);
  await expect(page.locator('.project-button')).toBeDisabled();
  await expect(
    page.getByRole('dialog', { name: 'Switch project' }),
  ).toHaveCount(0);
  expect(await calls(page, 'project_open')).toHaveLength(0);
  await release(page);
  await expect(row(page, 'renamed.txt')).toBeVisible();
  expect(await calls(page, 'file_rename')).toHaveLength(1);
  expect(await calls(page, 'file_trash')).toHaveLength(0);
  expect(await calls(page, 'file_create')).toHaveLength(0);
  await expect(toolbar(page)).toContainText('renamed.txt');
  await expect(page.locator('.project-button')).toBeEnabled();
});

for (const operation of ['save', 'reload', 'open'] as const) {
  test(`an in-flight file ${operation} prevents rename and Trash until its reply settles`, async ({
    page,
  }) => {
    if (operation === 'save') {
      await editFile(page, 'hello.txt', 'Saved by the pending write');
      await hold(page, 'file_save', 'hello.txt', true);
      await save(page).click();
    } else if (operation === 'reload') {
      await editFile(page, 'hello.txt');
      await hold(page, 'file_read', 'hello.txt', true);
      await page.evaluate(async () => {
        const modulePath = '/src/lib/editor.svelte.ts';
        const { reloadTab } = await import(/* @vite-ignore */ modulePath);
        void reloadTab();
      });
    } else {
      await hold(page, 'file_read', 'hello.txt', true);
      await row(page, 'hello.txt').click();
    }
    await pending(page);
    await row(page, 'hello.txt').press('F2');
    await expect(page.getByRole('alert')).toContainText(
      /hello\.txt|wait|finish/i,
    );
    await expect(explorer(page).getByRole('textbox')).toHaveCount(0);
    await row(page, 'hello.txt').press('ControlOrMeta+Backspace');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await calls(page, 'file_rename')).toHaveLength(0);
    expect(await calls(page, 'file_trash')).toHaveLength(0);
    await release(page);
    await expect(toolbar(page)).toContainText('hello.txt');
    await rename(page, 'hello.txt', 'settled.txt');
    await expect(row(page, 'settled.txt')).toBeVisible();
    await expect(page.locator('.cm-content')).toContainText(
      operation === 'save' ? 'Saved by the pending write' : 'before',
    );
    expect(await calls(page, 'file_rename')).toHaveLength(1);
  });
}

test('a rejected project transition releases file actions and keeps the original clean buffer', async ({
  page,
}) => {
  await editFile(page, 'hello.txt');
  await hold(page, 'project_open');
  await chooseOtherProject(page);
  await pending(page);
  await expect(
    explorer(page).getByRole('button', { name: 'New file', exact: true }),
  ).toBeDisabled();
  await row(page, 'hello.txt').press('F2');
  await row(page, 'hello.txt').press('ControlOrMeta+Backspace');
  await expect(explorer(page).getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await release(page, 'The other project is no longer available');
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await expect(page.locator('.project-root')).toHaveAttribute(
    'title',
    projectRoot,
  );
  await expect(toolbar(page)).toContainText('hello.txt');
  await expect(page.locator('.cm-content')).toContainText('before');
  await expect(
    explorer(page).getByRole('button', { name: 'New file', exact: true }),
  ).toBeEnabled();
  expect(await calls(page, 'file_trash')).toHaveLength(0);
  await rename(page, 'hello.txt', 'still-here.txt');
  await expect(row(page, 'still-here.txt')).toBeVisible();
  expect((await calls(page, 'file_rename'))[0].args.expectedProjectRoot).toBe(
    projectRoot,
  );
});

for (const outcome of ['success', 'failure'] as const) {
  test(`a stale rename ${outcome} cannot touch a new project's buffer or newer inline name`, async ({
    page,
  }) => {
    await editFile(page, 'hello.txt');
    await hold(page, 'file_rename', undefined, outcome === 'success');
    await rename(page, 'hello.txt', 'old-project-name.txt');
    await pending(page);
    // Normal navigation is blocked by the transaction. Simulate a context
    // teardown before a delayed IPC reply, then use the real project switcher.
    await page.evaluate(async () => {
      const explorerPath = '/src/lib/explorer.svelte.ts';
      const editorPath = '/src/lib/editor.svelte.ts';
      const { resetExplorer } = await import(/* @vite-ignore */ explorerPath);
      const { resetEditor } = await import(/* @vite-ignore */ editorPath);
      resetExplorer();
      resetEditor();
    });
    await chooseOtherProject(page);
    await expect(page.locator('.project-root')).toHaveAttribute(
      'title',
      otherProject,
    );
    await editFile(page, 'README.md', 'New project work that stays unsaved');
    await explorer(page)
      .getByRole('button', { name: 'New file', exact: true })
      .click();
    const field = explorer(page).getByRole('textbox', {
      name: 'New file name',
    });
    await field.fill('new-project-note.txt');
    await release(
      page,
      outcome === 'failure' ? 'Obsolete project rename failed' : '',
    );
    await expect(field).toHaveValue('new-project-note.txt');
    await expect(field).toBeEnabled();
    await expect(field).toBeFocused();
    await expect(page.locator('.project-root')).toHaveAttribute(
      'title',
      otherProject,
    );
    await expect(toolbar(page)).toContainText('README.md');
    await expect(page.locator('.cm-content')).toContainText(
      'New project work that stays unsaved',
    );
    await expect(page.locator('.file-status')).toContainText('Unsaved changes');
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Obsolete project rename failed' }),
    ).toHaveCount(0);
    await expect(explorer(page)).not.toContainText(
      'Renamed to old-project-name.txt',
    );
    await field.press('Enter');
    await expect(row(page, 'new-project-note.txt')).toBeVisible();
    expect((await calls(page, 'file_rename'))[0].args).toEqual({
      expectedProjectRoot: projectRoot,
      relativePath: 'hello.txt',
      name: 'old-project-name.txt',
    });
    expect((await calls(page, 'file_create'))[0].args).toEqual({
      expectedProjectRoot: otherProject,
      parent: '',
      name: 'new-project-note.txt',
      directory: false,
    });
    await expectUnsaved(
      page,
      'README.md',
      'New project work that stays unsaved',
    );
  });
}

test('a stale Trash confirmation cannot apply to the next project', async ({
  page,
}) => {
  await editFile(page, 'hello.txt');
  await askTrash(page, 'hello.txt');
  // Capture the pending decision as a delayed native/modal callback, cancel its
  // visible dialog, and invalidate its project before that decision arrives.
  await page.evaluate(async () => {
    const dialogPath = '/src/lib/dialog.svelte.ts';
    const explorerPath = '/src/lib/explorer.svelte.ts';
    const editorPath = '/src/lib/editor.svelte.ts';
    const { dialog } = await import(/* @vite-ignore */ dialogPath);
    const { resetExplorer } = await import(/* @vite-ignore */ explorerPath);
    const { resetEditor } = await import(/* @vite-ignore */ editorPath);
    (window as any).explorerStaleConfirmation = dialog.resolve;
    dialog.resolve = null;
    resetExplorer();
    resetEditor();
  });
  await chooseOtherProject(page);
  await expect(page.locator('.project-root')).toHaveAttribute(
    'title',
    otherProject,
  );
  await editFile(page, 'hello.txt', 'New project hello buffer');
  await page.evaluate(() =>
    (window as any).explorerStaleConfirmation('Move to Trash'),
  );
  await expect(row(page, 'hello.txt')).toBeVisible();
  await expectUnsaved(page, 'hello.txt', 'New project hello buffer');
  expect(await calls(page, 'file_trash')).toHaveLength(0);
  await expect(explorer(page)).not.toContainText(
    'Moved hello.txt to the Trash',
  );
});

test('inline rename supports selection, Escape focus, composition, and one blur submission', async ({
  page,
}) => {
  await row(page, 'hello.txt').focus();
  await row(page, 'hello.txt').press('F2');
  const field = explorer(page).getByRole('textbox', {
    name: 'Rename hello.txt',
  });
  await expect(field).toBeFocused();
  expect(
    await field.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, 5]);
  await field.fill('cancelled-rename.txt');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(row(page, 'hello.txt')).toBeFocused();
  expect(await calls(page, 'file_rename')).toHaveLength(0);
  await row(page, 'hello.txt').press('F2');
  await field.fill('composed-name.txt');
  await field.evaluate((input) => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  await expect(field).toHaveValue('composed-name.txt');
  expect(await calls(page, 'file_rename')).toHaveLength(0);
  await hold(page, 'file_rename');
  await field.press('Tab');
  await pending(page);
  await expect(field).toBeDisabled();
  await release(page);
  await expect(row(page, 'composed-name.txt')).toBeVisible();
  expect(await calls(page, 'file_rename')).toHaveLength(1);
});

test('rename keeps the existing editor undo history while the reservation blocks keyboard edits', async ({
  page,
}) => {
  await editFile(page, 'hello.txt', 'Saved content with undo history');
  await save(page).click();
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  await hold(page, 'file_rename');
  await rename(page, 'hello.txt', 'history.txt');
  await pending(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.type('must not enter the reserved buffer');
  await expect(page.locator('.cm-content')).toContainText(
    'Saved content with undo history',
  );
  await expect(page.locator('.cm-content')).not.toContainText('must not enter');
  await release(page);
  await expect(toolbar(page)).toContainText('history.txt');
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expectUnsaved(page, 'history.txt', 'before');
  await expect(page.locator('.cm-content')).not.toContainText(
    'Saved content with undo history',
  );
  expect(await calls(page, 'file_save')).toHaveLength(1);
  await expect(close(page, 'hello.txt')).toHaveCount(0);
});

test('a reserved viewed file disables Edit and disk-conflict controls until failure releases them', async ({
  page,
}) => {
  await openFile(page, 'hello.txt');
  await hold(page, 'file_read', 'hello.txt');
  await page.evaluate(async () => {
    const modulePath = '/src/lib/editor.svelte.ts';
    const { reloadTab } = await import(/* @vite-ignore */ modulePath);
    void reloadTab();
  });
  await pending(page);
  await release(page, 'Temporary disk read failure');
  const conflict = page.locator('.file-conflict-banner');
  await expect(conflict).toContainText('Temporary disk read failure');
  await hold(page, 'file_rename');
  await rename(page, 'hello.txt', 'reserved-view.txt');
  await pending(page);
  await expect(
    toolbar(page).getByRole('button', { name: 'Edit', exact: true }),
  ).toBeDisabled();
  await expect(
    conflict.getByRole('button', { name: 'Compare', exact: true }),
  ).toBeDisabled();
  await expect(
    conflict.getByRole('button', { name: 'Reload disk', exact: true }),
  ).toBeDisabled();
  await release(page, 'Rename could not finish');
  await expect(explorer(page).getByRole('alert')).toContainText(
    'Rename could not finish',
  );
  await expect(
    toolbar(page).getByRole('button', { name: 'Edit', exact: true }),
  ).toBeEnabled();
  await expect(
    conflict.getByRole('button', { name: 'Compare', exact: true }),
  ).toBeEnabled();
  await expect(
    conflict.getByRole('button', { name: 'Reload disk', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.cm-content')).toContainText('before');
  expect(await calls(page, 'file_save')).toHaveLength(0);
});

test('the delayed initial read of a created file cannot replace a newer dirty active file', async ({
  page,
}) => {
  await hold(page, 'file_read', 'created.txt', true);
  await explorer(page)
    .getByRole('button', { name: 'New file', exact: true })
    .click();
  const field = explorer(page).getByRole('textbox', { name: 'New file name' });
  await field.fill('created.txt');
  await field.press('Enter');
  await pending(page);
  await editFile(page, 'hello.txt', 'Typed while the created file was opening');
  await release(page);
  await expect(row(page, 'created.txt')).toBeVisible();
  await expect(toolbar(page)).toContainText('hello.txt');
  await expectUnsaved(
    page,
    'hello.txt',
    'Typed while the created file was opening',
  );
  await expect(
    explorer(page).getByRole('button', { name: 'New file', exact: true }),
  ).toBeEnabled();
  expect(await calls(page, 'file_create')).toHaveLength(1);
  expect(await calls(page, 'file_save')).toHaveLength(0);
});

test('renaming after a successful retry closes the old-path comparison and keeps the editor usable', async ({
  page,
}) => {
  await editFile(
    page,
    'hello.txt',
    'Content kept through comparison and rename',
  );
  await hold(page, 'file_save', 'hello.txt');
  await save(page).click();
  await pending(page);
  await release(page, 'Temporary save failure');
  await expect(page.locator('.file-conflict-banner')).toContainText(
    'Temporary save failure',
  );
  await page
    .locator('.file-conflict-banner')
    .getByRole('button', { name: 'Compare', exact: true })
    .click();
  const comparison = page.getByRole('region', {
    name: 'File conflict comparison',
    exact: true,
  });
  await expect(comparison).toBeVisible();
  await expect(comparison.locator('pre').nth(1)).toContainText('before');
  await save(page).click();
  await expect(page.locator('.file-status')).toContainText('Saved on disk');
  await expect(comparison).toBeVisible();
  await rename(page, 'hello.txt', 'reviewed.txt');
  await expect(row(page, 'reviewed.txt')).toBeVisible();
  await expect(comparison).toHaveCount(0);
  await expect(toolbar(page)).toContainText('reviewed.txt');
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'true',
  );
  await expect(page.locator('.cm-content')).toContainText(
    'Content kept through comparison and rename',
  );
  await page.locator('.cm-content').fill('Edits after the reviewed rename');
  await expectUnsaved(page, 'reviewed.txt', 'Edits after the reviewed rename');
  expect(await calls(page, 'file_save')).toHaveLength(2);
  expect((await calls(page, 'file_rename'))[0].args).toEqual({
    expectedProjectRoot: projectRoot,
    relativePath: 'hello.txt',
    name: 'reviewed.txt',
  });
});
