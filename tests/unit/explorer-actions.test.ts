import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/lib/api';
import { ask } from '../../src/lib/dialog.svelte';
import { createExplorerActions } from '../../src/lib/app/explorerActions';
import {
  checkFiles,
  closeTab,
  currentTab,
  editContent,
  editor,
  openFile,
  protectDirty,
  reloadTab,
  resetEditor,
  saveComparedTab,
  saveTab,
} from '../../src/lib/editor.svelte';
import { explorer, resetExplorer } from '../../src/lib/explorer.svelte';
import type { Entry, FileData, Tab } from '../../src/lib/types';

vi.mock('../../src/lib/api', () => ({
  api: {
    createEntry: vi.fn(),
    renameEntry: vi.fn(),
    trashEntry: vi.fn(),
    read: vi.fn(),
    save: vi.fn(),
    stat: vi.fn(),
  },
}));
vi.mock('../../src/lib/dialog.svelte', () => ({ ask: vi.fn() }));
const create = vi.mocked(api.createEntry),
  rename = vi.mocked(api.renameEntry),
  trash = vi.mocked(api.trashEntry),
  read = vi.mocked(api.read),
  save = vi.mocked(api.save),
  confirm = vi.mocked(ask);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function file(path = 'src/a.txt', content = 'original'): FileData {
  return {
    path,
    content,
    encoding: 'utf8',
    sizeBytes: content.length,
    newline: 'lf',
    fingerprint: {
      hash: 'original',
      modifiedNanos: '1',
      sizeBytes: content.length,
    },
    readOnlyRecommended: false,
  };
}
function tab(path = 'src/a.txt', extra: Partial<Tab> = {}) {
  editor.tabs.push({
    path,
    data: file(path),
    content: 'original',
    dirty: false,
    editing: true,
    mode: 'edit',
    cursor: 4,
    scroll: 12,
    ...extra,
  });
  const result = editor.tabs.at(-1)!;
  editor.active = path;
  return result;
}
function entry(path = 'src/a.txt', directory = false): Entry {
  return { path, name: path.split('/').at(-1)!, directory, symlink: false };
}
function fixture() {
  let project = { root: '/project' },
    ready = true;
  let discovered = [entry('src', true), entry(), entry('outside.txt')];
  let expanded = ['src'];
  const fail = vi.fn(),
    open = vi.fn(openFile);
  const actions = createExplorerActions({
    root: () => project.root,
    scope: () => project,
    ready: () => ready,
    discovered: () => discovered,
    setDiscovered: (value) => {
      discovered = value;
    },
    expanded: () => expanded,
    setExpanded: (value) => {
      expanded = value;
    },
    open,
    addContext: vi.fn(),
    fail,
  });
  return {
    actions,
    fail,
    open,
    discovered: () => discovered,
    expanded: () => expanded,
    setReady(value: boolean) {
      ready = value;
    },
    replace(root = '/project') {
      project = { root };
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  resetEditor();
  resetExplorer();
  confirm.mockResolvedValue('Move to Trash');
  read.mockImplementation(async (path) => file(path));
});
afterEach(() => resetExplorer());

async function renameStart(
  f: ReturnType<typeof fixture>,
  path = 'src/a.txt',
  directory = false,
) {
  await f.actions.treeAction(entry(path, directory), 'rename');
}

describe('scoped Explorer mutations', () => {
  it('blocks mutation and inline editing while project restoration is not ready', async () => {
    const f = fixture();
    f.setReady(false);
    f.actions.startCreate('', false);
    await renameStart(f);
    await f.actions.treeAction(entry(), 'trash');
    expect(explorer.editing).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });

  it('binds an inline edit to its original project identity even at the same root', async () => {
    const f = fixture();
    f.actions.startCreate('', false);
    f.replace();
    await f.actions.commitName('new.txt');
    expect(create).not.toHaveBeenCalled();
    expect(explorer.busy).toBe(false);
  });

  it('serializes duplicate commits and freezes only the affected subtree', async () => {
    const f = fixture(),
      target = tab(),
      sibling = tab('src/b.txt'),
      unrelated = tab('outside.txt', { dirty: true, content: 'keep me' });
    editor.active = target.path;
    const result = deferred<string>();
    rename.mockReturnValue(result.promise);
    await renameStart(f, 'src', true);
    const pending = f.actions.commitName('lib');
    await f.actions.commitName('ignored');
    await f.actions.treeAction(entry('outside.txt'), 'trash');
    f.actions.startCreate('', false);
    expect(rename).toHaveBeenCalledExactlyOnceWith('src', 'lib', '/project');
    expect(confirm).not.toHaveBeenCalled();
    expect(explorer.operation).toMatchObject({ kind: 'rename', path: 'src' });
    expect(target.fileOperation).toBe('rename');
    expect(sibling.fileOperation).toBe('rename');
    expect(unrelated.fileOperation).toBeUndefined();
    editContent('must not edit a moving path');
    expect(target.content).toBe('original');
    expect(await saveTab(target)).toBe(false);
    expect(await saveComparedTab(target, file())).toBe('cancelled');
    expect(await reloadTab(target)).toBe(false);
    expect(await closeTab(target.path)).toBe(false);
    await openFile('src/unopened.txt');
    await openFile('lib/unopened.txt');
    await checkFiles();
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await openFile(unrelated.path);
    editContent('unrelated new edits');
    result.resolve('lib');
    await pending;
    expect(editor.tabs).toEqual([target, sibling, unrelated]);
    expect(target).toMatchObject({
      path: 'lib/a.txt',
      content: undefined,
      cursor: 4,
      scroll: 12,
    });
    expect(target.data?.path).toBe('lib/a.txt');
    expect(sibling.path).toBe('lib/b.txt');
    expect(editor.active).toBe('outside.txt');
    expect(unrelated.content).toBe('unrelated new edits');
    expect(unrelated.dirty).toBe(true);
    expect(explorer.busy).toBe(false);
    expect(explorer.operation).toBeNull();
    expect(target.fileOperation).toBeUndefined();
    expect(f.expanded()).toEqual(['lib']);
  });

  it('renames the active tab in place without reopening or losing its state', async () => {
    const f = fixture(),
      target = tab();
    rename.mockResolvedValue('src/b.txt');
    await renameStart(f);
    await f.actions.commitName('b.txt');
    expect(currentTab()).toBe(target);
    expect(target.path).toBe('src/b.txt');
    expect(target.cursor).toBe(4);
    expect(target.scroll).toBe(12);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps same-name renames safe without duplicate tabs', async () => {
    const f = fixture(),
      target = tab();
    rename.mockResolvedValue(target.path);
    await renameStart(f);
    await f.actions.commitName('a.txt');
    expect(currentTab()).toBe(target);
    expect(editor.tabs).toHaveLength(1);
    expect(target.dirty).toBe(false);
    expect(target.fileOperation).toBeUndefined();
  });

  it('refuses an existing destination tab before invoking native rename', async () => {
    const f = fixture(),
      source = tab(),
      destination = tab('src/b.txt', {
        dirty: true,
        content: 'unsaved target',
      });
    await renameStart(f);
    await f.actions.commitName('b.txt');
    expect(rename).not.toHaveBeenCalled();
    expect(explorer.error).toContain('existing tab');
    expect(destination.content).toBe('unsaved target');
    expect(source.fileOperation).toBeUndefined();
  });

  it('rejects a canonical alias redirect and preserves both the source and dirty target', async () => {
    const f = fixture(),
      source = tab('alias/a.txt'),
      target = tab('real/a.txt', {
        dirty: true,
        content: 'dirty canonical target',
      });
    rename.mockResolvedValue('real/a.txt');
    await renameStart(f, 'alias/a.txt');
    await f.actions.commitName('a.txt');
    expect(rename).toHaveBeenCalledExactlyOnceWith(
      'alias/a.txt',
      'a.txt',
      '/project',
    );
    expect(editor.tabs).toEqual([source, target]);
    expect(source.path).toBe('alias/a.txt');
    expect(source.data?.path).toBe('alias/a.txt');
    expect(source.content).toBe('original');
    expect(source.dirty).toBe(true);
    expect(source.conflict).toContain('unexpected destination');
    expect(target.path).toBe('real/a.txt');
    expect(target.content).toBe('dirty canonical target');
    expect(target.dirty).toBe(true);
    expect(currentTab()).toBe(target);
    expect(explorer.error).toContain('unexpected destination');
    expect(explorer.editing?.mode).toBe('rename');
    expect(explorer.busy).toBe(false);
    expect(source.fileOperation).toBeUndefined();
  });

  it('does not partially relabel folder tabs when native returns a different destination', async () => {
    const f = fixture(),
      first = tab('alias/src/a.txt'),
      second = tab('alias/src/b.txt');
    rename.mockResolvedValue('real/lib');
    await renameStart(f, 'alias/src', true);
    await f.actions.commitName('lib');
    expect(editor.tabs.map(({ path }) => path)).toEqual([
      'alias/src/a.txt',
      'alias/src/b.txt',
    ]);
    expect(first.data?.path).toBe('alias/src/a.txt');
    expect(second.data?.path).toBe('alias/src/b.txt');
    expect(first.content).toBe('original');
    expect(second.content).toBe('original');
    expect(first.dirty).toBe(true);
    expect(second.dirty).toBe(true);
    expect(editor.active).toBe('alias/src/b.txt');
    expect(explorer.error).toContain('unexpected destination');
    expect(explorer.selected).toBe('');
    expect(explorer.revisions).toEqual({});
  });

  it('validates all returned subtree paths before relabeling when a target tab appears during I/O', async () => {
    const f = fixture(),
      first = tab('src/a.txt'),
      second = tab('src/b.txt'),
      result = deferred<string>();
    rename.mockReturnValue(result.promise);
    await renameStart(f, 'src', true);
    const pending = f.actions.commitName('lib');
    // Public opens are reserved, but direct restoration must also remain safe.
    const target = tab('lib/b.txt', {
      dirty: true,
      content: 'new target buffer',
    });
    result.resolve('lib');
    await pending;
    expect(editor.tabs).toEqual([first, second, target]);
    expect(editor.tabs.map(({ path }) => path)).toEqual([
      'src/a.txt',
      'src/b.txt',
      'lib/b.txt',
    ]);
    expect(first.data?.path).toBe('src/a.txt');
    expect(second.data?.path).toBe('src/b.txt');
    expect(first.content).toBe('original');
    expect(second.content).toBe('original');
    expect(target.content).toBe('new target buffer');
    expect(target.dirty).toBe(true);
    expect(explorer.error).toContain('already open in another tab');
    expect(first.fileOperation).toBeUndefined();
    expect(second.fileOperation).toBeUndefined();
  });

  it.each(['saving', 'reloading'] as const)(
    'refuses an affected pending %s without changing other dirty buffers',
    async (busy) => {
      const f = fixture(),
        target = tab('src/a.txt', { [busy]: true }),
        unrelated = tab('outside.txt', { dirty: true, content: 'keep this' });
      await renameStart(f);
      await f.actions.commitName('b.txt');
      expect(rename).not.toHaveBeenCalled();
      expect(f.fail).toHaveBeenCalledWith(
        expect.stringContaining('Wait for the current operation'),
      );
      expect(target.fileOperation).toBeUndefined();
      expect(unrelated.content).toBe('keep this');
      expect(unrelated.dirty).toBe(true);
    },
  );

  it('refuses a pending initial read and lets that read finish normally', async () => {
    const f = fixture(),
      result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const opening = openFile('src/a.txt');
    await renameStart(f);
    await f.actions.commitName('b.txt');
    expect(rename).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledWith(
      expect.stringContaining('Wait for the current operation'),
    );
    result.resolve(file());
    await opening;
    expect(currentTab()?.content).toBe('original');
  });

  it('refuses a dirty descendant while leaving the existing inline edit available', async () => {
    const f = fixture();
    await renameStart(f, 'src', true);
    const target = tab('src/a.txt', { dirty: true, content: 'new local' });
    await f.actions.commitName('lib');
    expect(rename).not.toHaveBeenCalled();
    expect(explorer.error).toContain('Save or discard');
    expect(explorer.editing?.mode).toBe('rename');
    expect(target.content).toBe('new local');
    expect(explorer.busy).toBe(false);
  });

  it('rechecks dirty files after Trash confirmation before calling native', async () => {
    const f = fixture(),
      target = tab(),
      approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = f.actions.treeAction(entry(), 'trash');
    expect(explorer.busy).toBe(true);
    expect(target.fileOperation).toBeUndefined();
    editContent('typed while deciding');
    approval.resolve('Move to Trash');
    await pending;
    expect(trash).not.toHaveBeenCalled();
    expect(explorer.error).toContain('Save or discard');
    expect(target.content).toBe('typed while deciding');
    expect(target.dirty).toBe(true);
    expect(explorer.busy).toBe(false);
  });

  it('does not duplicate Trash confirmation and releases the operation on cancellation', async () => {
    const f = fixture(),
      approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = f.actions.treeAction(entry(), 'trash');
    await f.actions.treeAction(entry(), 'trash');
    expect(confirm).toHaveBeenCalledTimes(1);
    approval.resolve('Cancel');
    await pending;
    expect(trash).not.toHaveBeenCalled();
    expect(explorer.busy).toBe(false);
    expect(explorer.operation).toBeNull();
  });

  it('refuses an affected close confirmation even if the buffer becomes clean', async () => {
    const f = fixture(),
      target = tab('src/a.txt', { dirty: true }),
      approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const closing = closeTab(target.path);
    // Another editor caller can clear dirty while the close dialog is pending.
    target.dirty = false;
    await renameStart(f);
    await f.actions.treeAction(entry(), 'trash');
    expect(explorer.editing).toBeNull();
    expect(f.fail).toHaveBeenCalledWith(
      expect.stringContaining('Wait for the current operation'),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    approval.resolve('Cancel');
    expect(await closing).toBe(false);
    expect(currentTab()).toBe(target);
  });

  it('ignores a Trash approval after replacing the project', async () => {
    const f = fixture(),
      approval = deferred<string>();
    tab();
    confirm.mockReturnValue(approval.promise);
    const pending = f.actions.treeAction(entry(), 'trash');
    f.replace('/other');
    resetEditor();
    resetExplorer();
    const replacement = tab('src/a.txt', {
      dirty: true,
      content: 'replacement',
    });
    f.actions.startCreate('', false);
    const edit = explorer.editing;
    approval.resolve('Move to Trash');
    await pending;
    expect(trash).not.toHaveBeenCalled();
    expect(currentTab()).toBe(replacement);
    expect(explorer.editing).toBe(edit);
    expect(explorer.error).toBe('');
    expect(explorer.note).toBe('');
  });

  it('reconciles a completed rename without clearing a replacement inline field', async () => {
    const f = fixture(),
      target = tab(),
      result = deferred<string>();
    rename.mockReturnValue(result.promise);
    await renameStart(f);
    const pending = f.actions.commitName('b.txt');
    explorer.editing = { mode: 'create', parent: 'new', directory: true };
    const edit = explorer.editing;
    explorer.error = 'new validation';
    result.resolve('src/b.txt');
    await pending;
    expect(currentTab()).toBe(target);
    expect(target.path).toBe('src/b.txt');
    expect(explorer.editing).toBe(edit);
    expect(explorer.error).toBe('new validation');
    expect(explorer.note).toBe('');
  });

  it('holds a Trash reservation until I/O completes and selects the surviving dirty tab', async () => {
    const f = fixture(),
      survivor = tab('outside.txt', { dirty: true, content: 'valuable' }),
      target = tab();
    const result = deferred<void>();
    trash.mockReturnValue(result.promise);
    const pending = f.actions.treeAction(entry(), 'trash');
    await Promise.resolve();
    expect(trash).toHaveBeenCalledExactlyOnceWith('src/a.txt', '/project');
    expect(target.fileOperation).toBe('trash');
    expect(await closeTab(target.path)).toBe(false);
    expect(await protectDirty()).toBe(false);
    editContent('blocked');
    expect(target.content).toBe('original');
    result.resolve();
    await pending;
    expect(editor.tabs).toEqual([survivor]);
    expect(currentTab()).toBe(survivor);
    expect(survivor.content).toBe('valuable');
    expect(survivor.dirty).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['rename', 'trash'] as const)(
    'releases %s reservations after a native failure',
    async (kind) => {
      const f = fixture(),
        target = tab();
      if (kind === 'rename') {
        rename.mockRejectedValue(new Error('Permission denied'));
        await renameStart(f);
        await f.actions.commitName('b.txt');
        expect(explorer.error).toBe('Permission denied');
      } else {
        trash.mockRejectedValue(new Error('Permission denied'));
        await f.actions.treeAction(entry(), 'trash');
        expect(explorer.error).toBe('Permission denied');
      }
      expect(target.fileOperation).toBeUndefined();
      expect(explorer.busy).toBe(false);
      editContent('can edit again');
      expect(target.content).toBe('can edit again');
      expect(target.dirty).toBe(true);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores stale create %s after a same-root replacement and preserves newer pending work',
    async (settle) => {
      const f = fixture(),
        oldResult = deferred<string>(),
        newResult = deferred<string>();
      create
        .mockReturnValueOnce(oldResult.promise)
        .mockReturnValueOnce(newResult.promise);
      f.actions.startCreate('', false);
      const oldRequest = f.actions.commitName('old.txt');
      f.replace();
      resetEditor();
      resetExplorer();
      f.actions.startCreate('new', true);
      const newRequest = f.actions.commitName('folder');
      const newOperation = explorer.operation,
        newEdit = explorer.editing;
      explorer.error = 'new status';
      if (settle === 'resolve') oldResult.resolve('old.txt');
      else oldResult.reject(new Error('old failure'));
      await oldRequest;
      expect(explorer.operation).toBe(newOperation);
      expect(explorer.editing).toBe(newEdit);
      expect(explorer.error).toBe('new status');
      expect(explorer.busy).toBe(true);
      expect(f.open).not.toHaveBeenCalled();
      expect(explorer.selected).toBe('');
      newResult.resolve('new/folder');
      await newRequest;
      expect(explorer.selected).toBe('new/folder');
    },
  );

  it('ignores a stale create open completion before enabling editing or showing status', async () => {
    const f = fixture(),
      opening = deferred<FileData>();
    create.mockResolvedValue('new.txt');
    read.mockReturnValue(opening.promise);
    f.actions.startCreate('', false);
    const pending = f.actions.commitName('new.txt');
    await Promise.resolve();
    expect(read).toHaveBeenCalledWith('new.txt');
    f.replace('/other');
    resetEditor();
    resetExplorer();
    const replacement = tab('new.txt', {
      editing: false,
      content: 'other project',
    });
    f.actions.startCreate('', false);
    const newEdit = explorer.editing;
    opening.resolve(file('new.txt', 'old project'));
    await pending;
    expect(currentTab()).toBe(replacement);
    expect(replacement.editing).toBe(false);
    expect(replacement.content).toBe('other project');
    expect(explorer.editing).toBe(newEdit);
    expect(explorer.note).toBe('');
  });

  it.each(['rename', 'trash'] as const)(
    'ignores stale %s completion after replacing tabs and operation state',
    async (kind) => {
      const f = fixture(),
        oldTab = tab(),
        result = deferred<string>();
      let pending: Promise<void>;
      if (kind === 'rename') {
        rename.mockReturnValue(result.promise);
        await renameStart(f);
        pending = f.actions.commitName('b.txt');
      } else {
        trash.mockImplementation(() => result.promise.then(() => undefined));
        pending = f.actions.treeAction(entry(), 'trash');
        await Promise.resolve();
      }
      f.replace('/other');
      resetEditor();
      resetExplorer();
      const replacement = tab('src/a.txt', {
        dirty: true,
        content: 'replacement',
      });
      f.actions.startCreate('', false);
      const newerEdit = explorer.editing;
      result.resolve('src/b.txt');
      await pending;
      expect(currentTab()).toBe(replacement);
      expect(replacement.content).toBe('replacement');
      expect(replacement.fileOperation).toBeUndefined();
      expect(oldTab.fileOperation).toBeUndefined();
      expect(explorer.editing).toBe(newerEdit);
      expect(explorer.selected).toBe('');
      expect(explorer.note).toBe('');
      expect(f.fail).not.toHaveBeenCalled();
    },
  );

  it('suppresses an old inline error without clearing or changing a replacement field', async () => {
    const f = fixture(),
      result = deferred<string>();
    create.mockReturnValue(result.promise);
    f.actions.startCreate('', false);
    const pending = f.actions.commitName('old.txt');
    explorer.editing = { mode: 'create', parent: 'new', directory: true };
    const replacement = explorer.editing;
    explorer.error = 'new validation';
    result.reject(new Error('old validation'));
    await pending;
    expect(explorer.editing).toBe(replacement);
    expect(explorer.error).toBe('new validation');
    expect(explorer.note).toBe('');
  });

  it('preserves unexpected newer text and retargets its tab after rename', async () => {
    const f = fixture(),
      target = tab(),
      result = deferred<string>();
    rename.mockReturnValue(result.promise);
    await renameStart(f);
    const pending = f.actions.commitName('b.txt');
    target.content = 'queued content from another caller';
    result.resolve('src/b.txt');
    await pending;
    expect(currentTab()).toBe(target);
    expect(target.path).toBe('src/b.txt');
    expect(target.content).toBe('queued content from another caller');
    expect(target.dirty).toBe(true);
  });

  it('preserves unexpected newer text after Trash as a dirty recoverable buffer', async () => {
    const f = fixture(),
      target = tab(),
      result = deferred<void>();
    trash.mockReturnValue(result.promise);
    const pending = f.actions.treeAction(entry(), 'trash');
    await Promise.resolve();
    target.content = 'queued content from another caller';
    result.resolve();
    await pending;
    expect(currentTab()).toBe(target);
    expect(target.content).toBe('queued content from another caller');
    expect(target.dirty).toBe(true);
    expect(target.conflict).toContain('Your unsaved text is preserved');
    expect(target.fileOperation).toBeUndefined();
  });
});
