import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/lib/api';
import { answer } from '../../src/lib/dialog.svelte';
import {
  closeTab,
  checkFiles,
  currentTab,
  editContent,
  editor,
  openFile,
  reloadTab,
  resetEditor,
  saveTab,
} from '../../src/lib/editor.svelte';
import type { FileData } from '../../src/lib/types';

vi.mock('../../src/lib/api', () => ({
  api: { read: vi.fn(), save: vi.fn(), stat: vi.fn() },
}));

function data(content = 'original', path = 'notes.txt'): FileData {
  return {
    path,
    content,
    encoding: 'utf8',
    newline: 'lf',
    sizeBytes: content.length,
    readOnlyRecommended: false,
    fingerprint: {
      hash: content,
      modifiedNanos: '1',
      sizeBytes: content.length,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  resetEditor();
  vi.resetAllMocks();
  vi.mocked(api.read).mockResolvedValue(data());
});

describe('editor data safety', () => {
  it('keeps unsaved edits when the replacement disk read fails', async () => {
    await openFile('notes.txt');
    editContent('unsaved');
    vi.mocked(api.read).mockRejectedValueOnce(new Error('File unavailable'));
    const reload = reloadTab();
    answer('Reload');
    await reload;
    expect(currentTab()).toMatchObject({ content: 'unsaved', dirty: true });
    expect(editor.error).toContain('File unavailable');
  });

  it('keeps edits made after a reload was requested', async () => {
    await openFile('notes.txt');
    const read = deferred<FileData>();
    vi.mocked(api.read).mockReturnValueOnce(read.promise);
    const reload = reloadTab();
    editContent('newer edits');
    read.resolve(data('disk version'));
    await reload;
    expect(currentTab()).toMatchObject({
      content: 'newer edits',
      dirty: true,
      conflict: 'New edits were made while reloading. Your edits were kept.',
    });
  });

  it('keeps the clean buffer visible if an external-change refresh fails', async () => {
    await openFile('notes.txt');
    vi.mocked(api.stat).mockResolvedValue(data('external').fingerprint);
    vi.mocked(api.read).mockRejectedValueOnce(new Error('File unavailable'));
    await checkFiles();
    expect(currentTab()).toMatchObject({ content: 'original', dirty: false });
    expect(editor.error).toContain('File unavailable');
  });

  it('does not reload a different project from a stale file-stat response', async () => {
    await openFile('notes.txt');
    const stat = deferred<FileData['fingerprint']>();
    vi.mocked(api.stat).mockReturnValueOnce(stat.promise);
    const check = checkFiles();
    resetEditor();
    vi.mocked(api.read).mockResolvedValueOnce(data('other project'));
    await openFile('notes.txt');
    stat.resolve(data('external').fingerprint);
    await check;
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(currentTab()?.content).toBe('other project');
  });

  it('keeps a closing tab open when edits arrive during its save', async () => {
    await openFile('notes.txt');
    editContent('first edit');
    const write = deferred<FileData>();
    vi.mocked(api.save).mockReturnValueOnce(write.promise);
    const close = closeTab('notes.txt');
    answer('Save');
    await Promise.resolve();
    editContent('second edit');
    write.resolve(data('first edit'));
    expect(await close).toBe(false);
    expect(currentTab()).toMatchObject({ content: 'second edit', dirty: true });
    expect(editor.error).toContain('New edits were made while saving');
  });

  it('coalesces duplicate saves so they cannot conflict with each other', async () => {
    await openFile('notes.txt');
    editContent('edited');
    const write = deferred<FileData>();
    vi.mocked(api.save).mockReturnValueOnce(write.promise);
    const first = saveTab();
    const second = saveTab();
    expect(api.save).toHaveBeenCalledTimes(1);
    write.resolve(data('edited'));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(currentTab()?.dirty).toBe(false);
  });

  it('does not revive a closed tab when its initial read arrives late', async () => {
    const read = deferred<FileData>();
    vi.mocked(api.read).mockReturnValueOnce(read.promise);
    const opening = openFile('notes.txt');
    await closeTab('notes.txt');
    read.resolve(data());
    await opening;
    expect(editor.tabs).toEqual([]);
    expect(editor.active).toBe('');
    expect(editor.loading).toBe(false);
  });

  it('ignores outstanding reads and errors after switching projects', async () => {
    const read = deferred<FileData>();
    vi.mocked(api.read).mockReturnValueOnce(read.promise);
    const opening = openFile('notes.txt');
    resetEditor();
    read.resolve(data());
    await opening;
    expect(editor.tabs).toEqual([]);
    expect(editor.active).toBe('');
    expect(editor.loading).toBe(false);
  });
});
