import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/lib/api';
import { ask } from '../../src/lib/dialog.svelte';
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
import type { FileData, Fingerprint, Tab } from '../../src/lib/types';

vi.mock('../../src/lib/api', () => ({
  api: { read: vi.fn(), save: vi.fn(), stat: vi.fn() },
}));
vi.mock('../../src/lib/dialog.svelte', () => ({ ask: vi.fn() }));
const read = vi.mocked(api.read),
  save = vi.mocked(api.save),
  stat = vi.mocked(api.stat),
  confirm = vi.mocked(ask);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fingerprint(version: string): Fingerprint {
  return { hash: version, modifiedNanos: version, sizeBytes: 20 };
}
function file(content = 'original\n', extra: Partial<FileData> = {}): FileData {
  return {
    path: 'a.txt',
    content,
    encoding: 'utf8',
    sizeBytes: content.length,
    newline: 'lf',
    fingerprint: fingerprint('original'),
    readOnlyRecommended: false,
    ...extra,
  };
}
function tab(extra: Partial<Tab> = {}) {
  editor.tabs.push({
    path: 'a.txt',
    data: file(),
    content: 'local\n',
    dirty: true,
    editing: true,
    mode: 'edit',
    cursor: 4,
    scroll: 12,
    conflict: 'Changed on disk',
    ...extra,
  });
  const result = editor.tabs.at(-1)!;
  editor.active = result.path;
  return result;
}
beforeEach(() => {
  vi.resetAllMocks();
  resetEditor();
  confirm.mockResolvedValue('Cancel');
});

describe('safe disk reload', () => {
  it('keeps the confirmation contract and changes nothing on cancellation', async () => {
    const target = tab();
    const baseline = target.data;
    expect(await reloadTab()).toBe(false);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Reload disk version?',
      'Your unsaved changes to a.txt will be discarded.',
      ['Reload', 'Cancel'],
    );
    expect(read).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      content: 'local\n',
      dirty: true,
      conflict: 'Changed on disk',
      reloading: false,
    });
    expect(target.data).toBe(baseline);
  });

  it.each([
    'File was deleted',
    'Permission denied',
    'File changed while reading; retry',
  ])(
    'preserves the buffer and baseline when reading fails: %s',
    async (error) => {
      const target = tab();
      const baseline = target.data;
      confirm.mockResolvedValue('Reload');
      read.mockRejectedValue(new Error(error));
      expect(await reloadTab()).toBe(false);
      expect(target.content).toBe('local\n');
      expect(target.dirty).toBe(true);
      expect(target.data).toBe(baseline);
      expect(target.conflict).toContain(error);
      expect(editor.error).toContain(error);
      expect(target.reloading).toBe(false);
    },
  );

  it.each(['binary', 'unsupported'])(
    'preserves editable contents when the disk version becomes %s',
    async (encoding) => {
      const target = tab();
      const baseline = target.data;
      confirm.mockResolvedValue('Reload');
      read.mockResolvedValue(file('', { content: null, encoding }));
      expect(await reloadTab(target)).toBe(false);
      expect(target.content).toBe('local\n');
      expect(target.dirty).toBe(true);
      expect(target.data).toBe(baseline);
      expect(target.conflict).toContain('not available as UTF-8 text');
    },
  );

  it('rejects a response for another path', async () => {
    const target = tab();
    const baseline = target.data;
    confirm.mockResolvedValue('Reload');
    read.mockResolvedValue(file('wrong file', { path: 'b.txt' }));
    expect(await reloadTab(target)).toBe(false);
    expect(target.data).toBe(baseline);
    expect(target.content).toBe('local\n');
    expect(target.dirty).toBe(true);
  });

  it('commits readable CRLF content only after approval and a successful read', async () => {
    const target = tab();
    const approval = deferred<string>(),
      result = deferred<FileData>();
    confirm.mockReturnValue(approval.promise);
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    expect(target.reloading).toBe(true);
    expect(read).not.toHaveBeenCalled();
    approval.resolve('Reload');
    await Promise.resolve();
    expect(read).toHaveBeenCalledExactlyOnceWith('a.txt');
    expect(target.content).toBe('local\n');
    expect(target.dirty).toBe(true);
    const disk = file('disk\r\nversion\r\n', {
      newline: 'crlf',
      fingerprint: fingerprint('fresh'),
    });
    result.resolve(disk);
    expect(await pending).toBe(true);
    expect(target).toMatchObject({
      content: 'disk\nversion\n',
      dirty: false,
      conflict: undefined,
      cursor: 4,
      scroll: 12,
      reloading: false,
    });
    expect(target.data).toEqual(disk);
  });

  it('refuses to read if text changes while approval is pending', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = reloadTab(target);
    editContent('typed during confirmation');
    approval.resolve('Reload');
    expect(await pending).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(target.content).toBe('typed during confirmation');
    expect(target.dirty).toBe(true);
  });

  it('retains edits typed after the read began', async () => {
    const target = tab({ dirty: false, content: 'original\n' });
    const baseline = target.data;
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    editContent('typed during read');
    result.resolve(file('new disk version'));
    expect(await pending).toBe(false);
    expect(target.content).toBe('typed during read');
    expect(target.data).toBe(baseline);
    expect(target.dirty).toBe(true);
  });

  it('treats edits followed by undo as a newer buffer revision', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = reloadTab(target);
    editContent('intermediate');
    editContent('local\n');
    approval.resolve('Reload');
    expect(await pending).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('releases a successful background reload while preserving metadata and navigation', async () => {
    const target = tab({ dirty: false, content: 'original\n' });
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    const other = tab({
      path: 'b.txt',
      data: file('b', { path: 'b.txt' }),
      content: 'b',
      dirty: false,
    });
    await openFile(other.path);
    editor.error = 'An error belonging to b.txt';
    const disk = file('fresh disk', { fingerprint: fingerprint('fresh') });
    result.resolve(disk);
    expect(await pending).toBe(true);
    expect(currentTab()).toBe(other);
    expect(other.content).toBe('b');
    expect(target.content).toBeUndefined();
    expect(target.data).toEqual({ ...disk, content: null });
    expect(target.dirty).toBe(false);
    expect(editor.error).toBe('An error belonging to b.txt');
  });

  it('retains newer dirty text when an obsolete background reload settles', async () => {
    const target = tab({
      dirty: false,
      content: 'original\n',
      conflict: undefined,
    });
    const baseline = target.data;
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    editContent('newer local text');
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    await openFile(other.path);
    result.resolve(file('fresh disk'));
    expect(await pending).toBe(false);
    expect(target.content).toBe('newer local text');
    expect(target.dirty).toBe(true);
    expect(target.data).toBe(baseline);
    expect(currentTab()).toBe(other);
  });

  it('ignores a read for a closed or replaced same-path tab', async () => {
    const target = tab({ dirty: false, content: 'original\n' });
    const baseline = target.data;
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    editor.tabs = [];
    const replacement = tab();
    result.resolve(file('new disk'));
    expect(await pending).toBe(false);
    expect(target.data).toBe(baseline);
    expect(replacement.content).toBe('local\n');
    expect(replacement.dirty).toBe(true);
    expect(currentTab()).toBe(replacement);
  });

  it('does not send a read after the project changes during confirmation', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = reloadTab(target);
    editor.tabs = [];
    tab();
    approval.resolve('Reload');
    expect(await pending).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not publish a stale reload error to the newly selected file', async () => {
    const target = tab({ dirty: false });
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    await openFile(other.path);
    result.reject(new Error('old read failed'));
    expect(await pending).toBe(false);
    expect(target.conflict).toContain('old read failed');
    expect(editor.error).toBe('');
  });

  it('blocks duplicate reloads, saves, and closes until the read settles', async () => {
    const target = tab({ dirty: false });
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = reloadTab(target);
    expect(await reloadTab(target)).toBe(false);
    expect(await saveTab(target)).toBe(false);
    expect(await closeTab(target.path)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    result.resolve(file('new disk'));
    expect(await pending).toBe(true);
  });
});

describe('safe saves', () => {
  it('preserves CRLF and sends the existing baseline fingerprint', async () => {
    const target = tab({ data: file('original\r\n', { newline: 'crlf' }) });
    save.mockResolvedValue(
      file('local\r\n', { newline: 'crlf', fingerprint: fingerprint('saved') }),
    );
    expect(await saveTab()).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith(
      'a.txt',
      fingerprint('original'),
      'local\r\n',
    );
    expect(target.content).toBe('local\n');
    expect(target.dirty).toBe(false);
    expect(target.conflict).toBeUndefined();
    expect(target.saving).toBe(false);
  });

  it('sends only one write for repeated Save and refuses reload/close during its ACK', async () => {
    const target = tab();
    const ack = deferred<FileData>();
    save.mockReturnValue(ack.promise);
    const pending = saveTab(target);
    expect(target.saving).toBe(true);
    expect(await saveTab(target)).toBe(false);
    expect(await reloadTab(target)).toBe(false);
    expect(await closeTab(target.path)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    ack.resolve(file('local\n'));
    expect(await pending).toBe(true);
    expect(target.saving).toBe(false);
  });

  it.each(['more typing\n', 'original\n'])(
    'keeps typing during an ACK dirty against the saved version: %s',
    async (newer) => {
      const target = tab();
      const ack = deferred<FileData>();
      save.mockReturnValue(ack.promise);
      const pending = saveTab(target);
      editContent(newer);
      ack.resolve(file('local\n', { fingerprint: fingerprint('saved') }));
      expect(await pending).toBe(true);
      expect(target.content).toBe(newer);
      expect(target.dirty).toBe(true);
      expect(target.data?.fingerprint).toEqual(fingerprint('saved'));
      expect(target.conflict).toBeUndefined();
    },
  );

  it.each(['rejected ACK', 'binary ACK', 'mismatched ACK'])(
    'protects newer text reverted to the old baseline after an uncertain %s',
    async (failure) => {
      const target = tab({ conflict: undefined });
      const baseline = target.data;
      const ack = deferred<FileData>();
      save.mockReturnValue(ack.promise);
      const pending = saveTab(target);
      editContent('original\n');
      expect(target.dirty).toBe(true);
      // The native write may already have landed before its read/ACK fails.
      if (failure === 'rejected ACK')
        ack.reject(new Error('write landed; read failed'));
      else if (failure === 'binary ACK')
        ack.resolve(file('', { encoding: 'binary', content: null }));
      else ack.resolve(file('newer disk content'));
      expect(await pending).toBe(false);
      expect(target.data).toBe(baseline);
      expect(target.dirty).toBe(true);
      editContent('original\n');
      expect(target.dirty).toBe(true);
      const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
      await openFile(other.path);
      expect(target.content).toBe('original\n');
      expect(target.data).toBe(baseline);
    },
  );

  it('keeps an unresolved conflict dirty after undo reaches the old baseline', () => {
    const target = tab();
    editContent('original\n');
    expect(target.content).toBe('original\n');
    expect(target.dirty).toBe(true);
    expect(target.conflict).toBe('Changed on disk');
  });

  it('does not evict a buffer reverted to the old baseline during a save', async () => {
    const target = tab();
    const ack = deferred<FileData>();
    save.mockReturnValue(ack.promise);
    const pending = saveTab(target);
    editContent('original\n');
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    await openFile(other.path);
    expect(target.content).toBe('original\n');
    ack.resolve(file('local\n'));
    expect(await pending).toBe(true);
    expect(target.content).toBe('original\n');
    expect(target.dirty).toBe(true);
  });

  it.each(['ordinary', 'compared'])(
    'releases clean inactive text immediately after a successful %s save ACK',
    async (operation) => {
      const target = tab();
      const ack = deferred<FileData>();
      confirm.mockResolvedValue('Save my version');
      save.mockReturnValue(ack.promise);
      const pending =
        operation === 'ordinary'
          ? saveTab(target)
          : saveComparedTab(target, file('external'));
      await Promise.resolve();
      const other = tab({
        path: 'b.txt',
        data: file('b', { path: 'b.txt' }),
        content: 'b',
        dirty: false,
      });
      await openFile(other.path);
      expect(target.content).toBe('local\n');
      const saved = file('local\n', { fingerprint: fingerprint('saved') });
      ack.resolve(saved);
      expect(await pending).toBe(operation === 'ordinary' ? true : 'saved');
      expect(target.content).toBeUndefined();
      expect(target.data).toEqual({ ...saved, content: null });
      expect(target.dirty).toBe(false);
      expect(target.conflict).toBeUndefined();
      expect(target.cursor).toBe(4);
      expect(target.scroll).toBe(12);
      expect(currentTab()).toBe(other);
      expect(other.content).toBe('b');
    },
  );

  it.each(['ordinary', 'compared'])(
    'retains text when reopening between the %s write ACK and the saving flag cleanup',
    async (operation) => {
      const target = tab();
      const ack = deferred<FileData>();
      confirm.mockResolvedValue('Save my version');
      save.mockReturnValue(ack.promise);
      const pending =
        operation === 'ordinary'
          ? saveTab(target)
          : saveComparedTab(target, file('external'));
      await Promise.resolve();
      const other = tab({
        path: 'b.txt',
        data: file('b', { path: 'b.txt' }),
        content: 'b',
        dirty: false,
      });
      await openFile(other.path);
      const saved = file('local\n', { fingerprint: fingerprint('saved') });
      let reopened: Promise<void> | undefined;
      ack.resolve(saved);
      // writeTab resumes first; this open runs before its caller's finally.
      queueMicrotask(() => {
        reopened = openFile(target.path);
      });
      expect(await pending).toBe(operation === 'ordinary' ? true : 'saved');
      await reopened;
      expect(currentTab()).toBe(target);
      expect(target.saving).toBe(false);
      expect(target.content).toBe('local\n');
      expect(target.data).toEqual(saved);
      expect(target.dirty).toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('retains newer dirty text and its saved baseline after a background save ACK', async () => {
    const target = tab();
    const ack = deferred<FileData>();
    save.mockReturnValue(ack.promise);
    const pending = saveTab(target);
    editContent('newer local text');
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    await openFile(other.path);
    const saved = file('local\n', { fingerprint: fingerprint('saved') });
    ack.resolve(saved);
    expect(await pending).toBe(true);
    expect(target.content).toBe('newer local text');
    expect(target.data).toEqual(saved);
    expect(target.dirty).toBe(true);
    expect(currentTab()).toBe(other);
  });

  it.each(['save', 'reload'])(
    'retains active contents when a newer open changes only the request generation during %s',
    async (operation) => {
      const target = tab({
        dirty: false,
        content: 'original\n',
        conflict: undefined,
      });
      const result = deferred<FileData>();
      save.mockReturnValue(result.promise);
      read.mockReturnValue(result.promise);
      const pending =
        operation === 'save' ? saveTab(target) : reloadTab(target);
      await openFile(target.path);
      const disk = file('original\n', { fingerprint: fingerprint('fresh') });
      result.resolve(disk);
      expect(await pending).toBe(true);
      expect(currentTab()).toBe(target);
      expect(target.content).toBe('original\n');
      expect(target.data).toEqual(disk);
      expect(target.dirty).toBe(false);
    },
  );

  it('preserves baseline, buffer, and dirtiness on rejected writes', async () => {
    const target = tab();
    const baseline = target.data;
    save.mockRejectedValue(new Error('CONFLICT: changed again'));
    expect(await saveTab()).toBe(false);
    expect(target.data).toBe(baseline);
    expect(target.content).toBe('local\n');
    expect(target.dirty).toBe(true);
    expect(target.conflict).toContain('changed again');
    expect(editor.error).toContain('changed again');
    expect(target.saving).toBe(false);
  });

  it.each([
    file('local\n', { path: 'wrong.txt' }),
    file('', { content: null, encoding: 'binary' }),
    file('a newer external change'),
  ])(
    'does not trust a mismatched or unavailable save ACK',
    async (response) => {
      const target = tab();
      const baseline = target.data;
      save.mockResolvedValue(response);
      expect(await saveTab()).toBe(false);
      expect(target.data).toBe(baseline);
      expect(target.content).toBe('local\n');
      expect(target.dirty).toBe(true);
      expect(target.conflict).toBeTruthy();
    },
  );

  it('ignores success after a project replaces the tab with the same path', async () => {
    const target = tab();
    const baseline = target.data;
    const ack = deferred<FileData>();
    save.mockReturnValue(ack.promise);
    const pending = saveTab(target);
    editor.tabs = [];
    const replacement = tab();
    ack.resolve(file('local\n', { fingerprint: fingerprint('saved') }));
    expect(await pending).toBe(false);
    expect(target.data).toBe(baseline);
    expect(replacement.data?.fingerprint).toEqual(fingerprint('original'));
    expect(replacement.dirty).toBe(true);
  });

  it('does not replace a baseline changed while a write was pending', async () => {
    const target = tab();
    const ack = deferred<FileData>();
    save.mockReturnValue(ack.promise);
    const pending = saveTab(target);
    target.data = file('a more recent baseline', {
      fingerprint: fingerprint('newer'),
    });
    ack.resolve(file('local\n'));
    expect(await pending).toBe(false);
    expect(target.data.fingerprint).toEqual(fingerprint('newer'));
    expect(target.dirty).toBe(true);
    expect(target.conflict).toBe('Changed on disk');
  });

  it('keeps a stale save error out of the newly selected tab', async () => {
    const target = tab();
    const ack = deferred<FileData>();
    save.mockReturnValue(ack.promise);
    const pending = saveTab(target);
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    await openFile(other.path);
    editor.error = 'current error';
    ack.reject(new Error('old save failed'));
    expect(await pending).toBe(false);
    expect(target.conflict).toContain('old save failed');
    expect(editor.error).toBe('current error');
    expect(other.conflict).toBe('Changed on disk');
  });
});

describe('saving a compared local version', () => {
  it('uses the explicitly reviewed disk fingerprint and newline after approval', async () => {
    const target = tab();
    const baseline = target.data;
    const disk = file('external\r\n', {
      newline: 'crlf',
      fingerprint: fingerprint('compared'),
    });
    const approval = deferred<string>(),
      ack = deferred<FileData>();
    confirm.mockReturnValue(approval.promise);
    save.mockReturnValue(ack.promise);
    const pending = saveComparedTab(target, disk);
    expect(target.saving).toBe(true);
    expect(confirm).toHaveBeenCalledWith(
      'Save your version?',
      expect.any(String),
      ['Save my version', 'Cancel'],
    );
    expect(save).not.toHaveBeenCalled();
    expect(target.data).toBe(baseline);
    approval.resolve('Save my version');
    await Promise.resolve();
    expect(save).toHaveBeenCalledExactlyOnceWith(
      'a.txt',
      fingerprint('compared'),
      'local\r\n',
    );
    expect(target.data).toBe(baseline);
    expect(target.conflict).toBe('Changed on disk');
    editContent('newer\n');
    ack.resolve(
      file('local\r\n', { newline: 'crlf', fingerprint: fingerprint('saved') }),
    );
    expect(await pending).toBe('saved');
    expect(target.content).toBe('newer\n');
    expect(target.dirty).toBe(true);
    expect(target.data?.fingerprint).toEqual(fingerprint('saved'));
    expect(target.saving).toBe(false);
  });

  it('keeps the reviewed fingerprint immutable while confirmation is pending', async () => {
    const target = tab();
    const disk = file('external\r\n', {
      newline: 'crlf',
      fingerprint: fingerprint('reviewed'),
    });
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    save.mockResolvedValue(file('local\r\n', { newline: 'crlf' }));
    const pending = saveComparedTab(target, disk);
    disk.fingerprint.hash = 'unreviewed';
    disk.newline = 'lf';
    approval.resolve('Save my version');
    expect(await pending).toBe('saved');
    expect(save).toHaveBeenCalledWith(
      'a.txt',
      fingerprint('reviewed'),
      'local\r\n',
    );
  });

  it.each([
    file('wrong', { path: 'b.txt' }),
    file('', { encoding: 'binary', content: null }),
    file('', { encoding: 'unsupported', content: null }),
    file('', { content: null }),
  ])('refuses a comparison that is not same-path UTF-8 text', async (disk) => {
    const target = tab();
    const baseline = target.data;
    expect(await saveComparedTab(target, disk)).toBe('failed');
    expect(confirm).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(target.data).toBe(baseline);
    expect(target.dirty).toBe(true);
  });

  it('cancels without adopting the comparison baseline or clearing the conflict', async () => {
    const target = tab();
    const baseline = target.data;
    expect(await saveComparedTab(target, file('external'))).toBe('cancelled');
    expect(save).not.toHaveBeenCalled();
    expect(target.data).toBe(baseline);
    expect(target.conflict).toBe('Changed on disk');
    expect(target.saving).toBe(false);
  });

  it('refuses changed local text even after it is changed back before approval', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = saveComparedTab(target, file('external'));
    editContent('newer');
    editContent('local\n');
    approval.resolve('Save my version');
    expect(await pending).toBe('failed');
    expect(save).not.toHaveBeenCalled();
    expect(target.dirty).toBe(true);
  });

  it.each(['removed', 'replaced', 'renamed'])(
    'refuses approval for a tab whose identity was %s',
    async (change) => {
      const target = tab();
      const approval = deferred<string>();
      confirm.mockReturnValue(approval.promise);
      const pending = saveComparedTab(target, file('external'));
      if (change === 'renamed') target.path = 'b.txt';
      else editor.tabs = [];
      if (change === 'replaced') tab();
      approval.resolve('Save my version');
      expect(await pending).toBe('cancelled');
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('retains the original baseline after a newer disk write rejects the compared save', async () => {
    const target = tab();
    const baseline = target.data;
    confirm.mockResolvedValue('Save my version');
    save.mockRejectedValue(new Error('CONFLICT: changed again'));
    expect(
      await saveComparedTab(
        target,
        file('external', { fingerprint: fingerprint('reviewed') }),
      ),
    ).toBe('failed');
    expect(target.data).toBe(baseline);
    expect(target.content).toBe('local\n');
    expect(target.dirty).toBe(true);
    expect(target.conflict).toContain('changed again');
  });

  it('protects reverted local text if a compared write lands but its ACK fails', async () => {
    const target = tab();
    const baseline = target.data;
    const ack = deferred<FileData>();
    confirm.mockResolvedValue('Save my version');
    save.mockReturnValue(ack.promise);
    const pending = saveComparedTab(target, file('external'));
    await Promise.resolve();
    editContent('original\n');
    ack.reject(new Error('write landed; read failed'));
    expect(await pending).toBe('failed');
    expect(target.data).toBe(baseline);
    expect(target.dirty).toBe(true);
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    await openFile(other.path);
    expect(target.content).toBe('original\n');
  });

  it('prevents repeated comparison confirmations and ordinary saves', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = saveComparedTab(target, file('external'));
    expect(await saveComparedTab(target, file('external'))).toBe('cancelled');
    expect(await saveTab(target)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    approval.resolve('Cancel');
    expect(await pending).toBe('cancelled');
  });
});

describe('closing and protecting dirty tabs', () => {
  it('keeps the tab open if the user types after Save while its ACK is pending', async () => {
    const target = tab();
    const ack = deferred<FileData>();
    confirm.mockResolvedValue('Save');
    save.mockReturnValue(ack.promise);
    const pending = closeTab(target.path);
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    editContent('typed after Save');
    ack.resolve(file('local\n'));
    expect(await pending).toBe(false);
    expect(currentTab()).toBe(target);
    expect(target.content).toBe('typed after Save');
    expect(target.dirty).toBe(true);
  });

  it('closes after Save when no new edits arrive', async () => {
    tab();
    confirm.mockResolvedValue('Save');
    save.mockResolvedValue(file('local\n'));
    expect(await closeTab('a.txt')).toBe(true);
    expect(editor.tabs).toHaveLength(0);
    expect(editor.active).toBe('');
  });

  it.each(['Save', 'Don’t Save'])(
    'does not discard text typed while the %s confirmation is pending',
    async (choice) => {
      const target = tab();
      const approval = deferred<string>();
      confirm.mockReturnValue(approval.promise);
      const pending = closeTab(target.path);
      editContent('new text');
      approval.resolve(choice);
      expect(await pending).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(currentTab()).toBe(target);
      expect(target.content).toBe('new text');
    },
  );

  it('keeps a replacement tab open after an old discard confirmation', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = closeTab(target.path);
    editor.tabs = [];
    const replacement = tab();
    approval.resolve('Don’t Save');
    expect(await pending).toBe(false);
    expect(currentTab()).toBe(replacement);
  });

  it('does not issue repeated close dialogs', async () => {
    const target = tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = closeTab(target.path);
    expect(await closeTab(target.path)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    approval.resolve('Cancel');
    expect(await pending).toBe(false);
  });

  it('refuses project teardown if a newly opened tab becomes dirty during a confirmation', async () => {
    tab();
    const approval = deferred<string>();
    confirm.mockReturnValue(approval.promise);
    const pending = protectDirty();
    const other = tab({ path: 'b.txt', data: file('b', { path: 'b.txt' }) });
    approval.resolve('Don’t Save');
    expect(await pending).toBe(false);
    expect(currentTab()).toBe(other);
    expect(other.dirty).toBe(true);
  });
});

describe('opening and checking files', () => {
  it('does not overwrite a dirty buffer with missing metadata', async () => {
    const target = tab({ data: undefined });
    await openFile(target.path);
    expect(read).not.toHaveBeenCalled();
    expect(target.content).toBe('local\n');
    expect(target.dirty).toBe(true);
  });

  it('preserves an existing clean buffer if its missing metadata reload is not text', async () => {
    const target = tab({
      data: undefined,
      dirty: false,
      content: 'existing text',
    });
    read.mockResolvedValue(
      file('', { encoding: 'unsupported', content: null }),
    );
    await openFile(target.path);
    expect(target.content).toBe('existing text');
    expect(target.data).toBeUndefined();
    expect(editor.error).toContain('not available as UTF-8 text');
  });

  it('does not replace a buffer edited while an initial load is pending', async () => {
    const target = tab({ data: undefined, content: undefined, dirty: false });
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = openFile(target.path);
    editContent('new local content');
    result.resolve(file('disk content'));
    await pending;
    expect(target.content).toBe('new local content');
    expect(target.dirty).toBe(true);
    expect(target.data).toBeUndefined();
  });

  it('resets loading and errors immediately on project replacement and invalidates pending opens', async () => {
    const older = deferred<FileData>(),
      newer = deferred<FileData>();
    read.mockImplementation((path) =>
      path === 'a.txt' ? older.promise : newer.promise,
    );
    const oldRequest = openFile('a.txt');
    editor.error = 'old project error';
    resetEditor();
    expect(editor.tabs).toHaveLength(0);
    expect(editor.active).toBe('');
    expect(editor.loading).toBe(false);
    expect(editor.error).toBe('');
    const newRequest = openFile('b.txt');
    older.reject(new Error('old project no longer exists'));
    await oldRequest;
    expect(editor.loading).toBe(true);
    expect(editor.error).toBe('');
    newer.resolve(file('new project', { path: 'b.txt' }));
    await newRequest;
    expect(editor.active).toBe('b.txt');
    expect(editor.loading).toBe(false);
    expect(currentTab()?.content).toBe('new project');
  });

  it('ignores an older read failure after newer navigation succeeds', async () => {
    const older = deferred<FileData>();
    read.mockImplementation((path) =>
      path === 'a.txt' ? older.promise : Promise.resolve(file('b', { path })),
    );
    const pending = openFile('a.txt');
    await openFile('b.txt');
    older.reject(new Error('old failure'));
    await pending;
    expect(editor.active).toBe('b.txt');
    expect(editor.error).toBe('');
    expect(editor.loading).toBe(false);
  });

  it('does not reactivate a closed tab after its read returns', async () => {
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = openFile('a.txt');
    expect(await closeTab('a.txt')).toBe(true);
    expect(editor.loading).toBe(false);
    result.resolve(file());
    await pending;
    expect(editor.tabs).toHaveLength(0);
    expect(editor.active).toBe('');
    expect(editor.loading).toBe(false);
  });

  it('ignores a same-path read after the project replaces its tabs', async () => {
    const result = deferred<FileData>();
    read.mockReturnValue(result.promise);
    const pending = openFile('a.txt');
    editor.tabs = [];
    const replacement = tab();
    result.resolve(file('old project'));
    await pending;
    expect(currentTab()).toBe(replacement);
    expect(replacement.content).toBe('local\n');
    expect(replacement.dirty).toBe(true);
  });

  it('retains the active clean buffer when an automatic refresh cannot read disk', async () => {
    const target = tab({ content: 'original\n', dirty: false });
    const baseline = target.data;
    stat.mockResolvedValue(fingerprint('external'));
    read.mockRejectedValue(new Error('read failed'));
    await checkFiles();
    expect(target.data).toBe(baseline);
    expect(target.content).toBe('original\n');
    expect(target.dirty).toBe(false);
    expect(target.conflict).toContain('read failed');
  });

  it('detects a size-only fingerprint change and reads before committing', async () => {
    const target = tab({ content: 'original\n', dirty: false });
    stat.mockResolvedValue({ ...fingerprint('original'), sizeBytes: 99 });
    read.mockResolvedValue(file('new disk'));
    await checkFiles();
    expect(read).toHaveBeenCalledExactlyOnceWith('a.txt');
    expect(target.content).toBe('new disk');
    expect(target.dirty).toBe(false);
  });

  it('does not adopt a stale stat result after a newer save ACK', async () => {
    const target = tab();
    const result = deferred<Fingerprint>();
    stat.mockReturnValue(result.promise);
    const pending = checkFiles();
    save.mockResolvedValue(
      file('local\n', { fingerprint: fingerprint('saved') }),
    );
    expect(await saveTab(target)).toBe(true);
    result.resolve(fingerprint('old stat'));
    await pending;
    expect(target.data?.fingerprint).toEqual(fingerprint('saved'));
    expect(target.content).toBe('local\n');
    expect(target.conflict).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('detects edits that arrive while stat is pending without reloading them', async () => {
    const target = tab({ content: 'original\n', dirty: false });
    const result = deferred<Fingerprint>();
    stat.mockReturnValue(result.promise);
    const pending = checkFiles();
    editContent('new local edit');
    result.resolve(fingerprint('changed'));
    await pending;
    expect(target.content).toBe('new local edit');
    expect(target.dirty).toBe(true);
    expect(target.conflict).toContain('unsaved edits');
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves detached tabs alone when stat fails after a project change', async () => {
    const target = tab();
    const result = deferred<Fingerprint>();
    stat.mockReturnValue(result.promise);
    const pending = checkFiles();
    editor.tabs = [];
    const replacement = tab();
    result.reject(new Error('old project missing'));
    await pending;
    expect(target.conflict).toBe('Changed on disk');
    expect(replacement.conflict).toBe('Changed on disk');
    expect(editor.error).toBe('');
  });
});
