import { describe, expect, it } from 'vitest';
import {
  addFileContext,
  assertFileContextDraft,
  contextBytes,
  createEditorSnapshot,
  createFileReference,
  createSelectionContext,
  MAX_FILE_REFERENCES,
  MAX_FROZEN_TOTAL_BYTES,
  MAX_FROZEN_CONTEXTS,
  MAX_FROZEN_CONTEXT_BYTES,
} from '../../src/lib/fileContext';
import type { Context, Tab } from '../../src/lib/types';

const root = '/projects/bindaas';
const bodyMarker = 'Captured text follows verbatim:\n\n';
function buffer(content = '', path = 'src/main.ts'): Tab {
  return {
    path,
    content,
    dirty: false,
    editing: true,
    mode: 'edit',
    cursor: 0,
    scroll: 0,
    data: {
      path,
      content,
      encoding: 'utf8',
      sizeBytes: contextBytes(content),
      newline: 'lf',
      fingerprint: {
        sizeBytes: contextBytes(content),
        modifiedNanos: '1',
        hash: 'old',
      },
      readOnlyRecommended: false,
    },
  };
}
function body(context: Context) {
  return context.text.slice(
    context.text.indexOf(bodyMarker) + bodyMarker.length,
  );
}
function sizedSnapshot(path: string, bytes: number) {
  const overhead = contextBytes(
    createEditorSnapshot(root, buffer('', path)).text,
  );
  return createEditorSnapshot(root, buffer('x'.repeat(bytes - overhead), path));
}
function selection(
  path = 'src/main.ts',
  fromLine = 2,
  toLine = 3,
  text = 'a\nb',
) {
  return createSelectionContext(root, {
    path,
    text,
    fromLine,
    toLine,
    dirty: true,
  });
}

describe('file context provenance', () => {
  it('makes a reference explicit about omitted unsaved content', () => {
    const reference = createFileReference(root, 'src/main.ts');
    expect(reference.label).toBe('src/main.ts');
    expect(reference.file).toEqual({
      kind: 'reference',
      projectRoot: root,
      path: 'src/main.ts',
      directory: false,
    });
    expect(reference.text).toContain('File reference (disk only)');
    expect(reference.text).toContain('No file contents are attached');
    expect(reference.text).toContain('excludes unsaved editor text');
    expect(reference.text).not.toContain(bodyMarker);
    expect(reference.text).not.toContain(root);
    expect(reference.text).not.toContain('Project:');
  });

  it('keeps folders as references without implying their contents were read', () => {
    const folder = createFileReference(root, 'src', true);
    expect(folder.label).toBe('src');
    expect(folder.file).toMatchObject({ kind: 'reference', directory: true });
    expect(folder.text).toContain('Folder reference (disk only)');
    expect(folder.text).toContain('Folder: "src"');
    expect(createFileReference(root, '.', true).file?.path).toBe('.');
  });

  it('captures exact unsaved editor text without using or changing the disk copy', () => {
    const tab = buffer('saved text\n');
    tab.content =
      '\ufeff  unsaved\r\n\t雪 and 🦊\n```\n' +
      bodyMarker +
      'tail without newline';
    tab.dirty = true;
    const before = structuredClone(tab);
    const snapshot = createEditorSnapshot(root, tab);
    expect(snapshot.label).toBe('src/main.ts · editor snapshot');
    expect(snapshot.file).toEqual({
      kind: 'snapshot',
      projectRoot: root,
      path: tab.path,
      dirty: true,
    });
    expect(snapshot.text).toContain('Frozen editor snapshot');
    expect(snapshot.text).not.toContain(root);
    expect(snapshot.text).toContain('Unsaved edits at capture: yes');
    expect(snapshot.text).toContain('may include unsaved edits');
    expect(snapshot.text).toContain('does not save or modify disk');
    expect(snapshot.text).toContain('will not automatically refresh');
    expect(body(snapshot)).toBe(tab.content);
    expect(snapshot.text).not.toContain('saved text\n');
    expect(snapshot.file).not.toHaveProperty('text');
    expect(snapshot.file).not.toHaveProperty('content');
    expect(tab).toEqual(before);
  });

  it('allows an empty file snapshot and honestly labels clean editor text', () => {
    const snapshot = createEditorSnapshot(root, buffer());
    expect(body(snapshot)).toBe('');
    expect(snapshot.text.endsWith(bodyMarker)).toBe(true);
    expect(snapshot.file?.dirty).toBe(false);
    expect(snapshot.text).toContain('Unsaved edits at capture: no');
  });

  it('freezes both the context and scalar source metadata at capture time', () => {
    const tab = buffer('old');
    const snapshot = createEditorSnapshot(root, tab);
    const capture = {
      path: tab.path,
      text: 'first',
      fromLine: 1,
      toLine: 1,
      dirty: false,
    };
    const selected = createSelectionContext(root, capture);
    const reference = createFileReference(root, tab.path);
    tab.content = 'new';
    tab.path = 'renamed.ts';
    tab.dirty = true;
    tab.data!.content = 'new disk text';
    capture.path = 'other.ts';
    capture.text = 'changed';
    capture.fromLine = 8;
    capture.dirty = true;
    for (const context of [snapshot, selected, reference]) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.file)).toBe(true);
      expect(() => Object.assign(context, { text: 'changed' })).toThrow();
      expect(() =>
        Object.assign(context.file!, { path: 'changed.ts' }),
      ).toThrow();
      expect(context.file?.path).toBe('src/main.ts');
    }
    expect(body(snapshot)).toBe('old');
    expect(body(selected)).toBe('first');
    expect(selected.file).toMatchObject({ dirty: false, fromLine: 1 });
  });

  it.each(['binary', 'unsupported', 'utf16'])(
    'rejects %s data despite a placeholder buffer',
    (encoding) => {
      const tab = buffer('placeholder');
      tab.data!.encoding = encoding;
      expect(() => createEditorSnapshot(root, tab)).toThrow(
        /readable text file/,
      );
    },
  );

  it('rejects an unreadable file or missing buffer without falling back to disk text', () => {
    const unreadable = buffer();
    delete unreadable.data;
    expect(() => createEditorSnapshot(root, unreadable)).toThrow(
      /readable text file/,
    );
    const nontext = buffer();
    nontext.data!.content = null;
    expect(() => createEditorSnapshot(root, nontext)).toThrow(
      /readable text file/,
    );
    const unloaded = buffer('saved text');
    delete unloaded.content;
    expect(() => createEditorSnapshot(root, unloaded)).toThrow(
      /no loaded editor buffer/,
    );
  });

  it('rejects NUL-bearing buffer and selection text', () => {
    expect(() => createEditorSnapshot(root, buffer('a\0b'))).toThrow(
      /Binary content/,
    );
    expect(() => selection('src/a', 1, 1, '\0')).toThrow(/Binary content/);
  });

  it('captures an existing dirty buffer even if a disk conflict is present', () => {
    const tab = buffer('my unsaved changes');
    tab.dirty = true;
    tab.conflict = 'File changed on disk';
    expect(body(createEditorSnapshot(root, tab))).toBe(tab.content);
  });
});

describe('selection context', () => {
  it('records exact selected text, line range, path, and dirty state', () => {
    const context = selection('src/app.ts', 4, 6, '  a\r\nb\nc\n');
    expect(context.label).toBe('src/app.ts · lines 4–6');
    expect(context.file).toEqual({
      kind: 'selection',
      projectRoot: root,
      path: 'src/app.ts',
      dirty: true,
      fromLine: 4,
      toLine: 6,
    });
    expect(context.text).toContain('Frozen editor selection snapshot');
    expect(context.text).not.toContain(root);
    expect(context.text).toContain('Lines: 4–6');
    expect(context.text).toContain('does not save or modify disk');
    expect(body(context)).toBe('  a\r\nb\nc\n');
  });

  it('rejects empty selections but preserves whitespace-only selections', () => {
    expect(() => selection('src/a', 1, 1, '')).toThrow(
      /Select some editor text/,
    );
    expect(body(selection('src/a', 1, 1, ' \t '))).toBe(' \t ');
    expect(body(selection('src/a', 1, 2, '\n'))).toBe('\n');
  });

  it.each([
    [0, 1],
    [3, 2],
    [-1, 1],
    [1.5, 2],
    [1, 2.5],
    [NaN, 2],
    [1, Infinity],
    [1, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid line bounds %s–%s', (fromLine, toLine) => {
    expect(() => selection('src/a', fromLine, toLine)).toThrow(
      /valid, ordered/,
    );
  });

  it('rejects a mismatched line span but accepts both newline endpoint conventions', () => {
    expect(() => selection('src/a', 3, 3, 'a\nb')).toThrow(/does not match/);
    expect(() => selection('src/a', 3, 4, 'a')).toThrow(/does not match/);
    expect(body(selection('src/a', 3, 3, 'a\n'))).toBe('a\n');
    expect(body(selection('src/a', 3, 4, 'a\n'))).toBe('a\n');
  });
});

describe('file source identity and paths', () => {
  it('namespaces stable IDs by project, kind, path, and selection range', () => {
    const first = createEditorSnapshot(root, buffer('before'));
    const second = createEditorSnapshot(root, buffer('after'));
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^bindaas:file-context:/);
    const contexts = [
      first,
      createFileReference(root, 'src/main.ts'),
      selection(),
      selection('src/main.ts', 5, 6),
      selection('src/other.ts'),
      createEditorSnapshot('/other', buffer()),
    ];
    expect(new Set(contexts.map((context) => context.id)).size).toBe(
      contexts.length,
    );
    expect(selection('src/main.ts', 2, 3, 'new\ntext').id).toBe(selection().id);
  });

  it('normalizes harmless relative components and trailing project separators', () => {
    const first = createFileReference(root, 'src/main.ts');
    const second = createFileReference(root + '/', './src//./main.ts');
    expect(second).toEqual(first);
    expect(createFileReference('/', 'a').file?.projectRoot).toBe('/');
  });

  it('keeps legal filename characters and JSON-quotes multiline provenance', () => {
    const path = ' src/quote" slash\\: snow雪\nFile: fake.ts ';
    const reference = createFileReference('/project\nFolder: fake', path);
    expect(reference.label).toBe(path);
    expect(reference.file?.path).toBe(path);
    expect(reference.text).toContain(`File: ${JSON.stringify(path)}`);
    expect(reference.text).not.toContain('\nFile: fake.ts');
    expect(reference.text).not.toContain('\nFolder: fake');
    expect(createFileReference(root, ' ').file?.path).toBe(' ');
  });

  it.each([
    '',
    '/outside.ts',
    '../outside.ts',
    'src/../outside.ts',
    'src/\0bad',
  ])('rejects invalid relative path %j for all sources', (path) => {
    expect(() => createFileReference(root, path)).toThrow(/path inside/);
    expect(() => createEditorSnapshot(root, buffer('', path))).toThrow(
      /path inside/,
    );
    expect(() => selection(path)).toThrow(/path inside/);
  });

  it('requires a file path for frozen content and an absolute project root', () => {
    expect(() => createEditorSnapshot(root, buffer('', '.'))).toThrow(
      /Choose a file/,
    );
    expect(() => createFileReference('', 'file')).toThrow(/Choose a project/);
    expect(() => createFileReference('project', 'file')).toThrow(
      /Choose a project/,
    );
    expect(() => createFileReference('/project\0', 'file')).toThrow(
      /Choose a project/,
    );
  });
});

describe('bounded context accounting', () => {
  it('counts UTF-8 bytes rather than UTF-16 units', () => {
    expect(contextBytes('')).toBe(0);
    expect(contextBytes('A雪🦊e\u0301')).toBe(11);
    expect(contextBytes('\ud800')).toBe(3);
  });

  it('accepts exactly 64 KiB including headers and rejects one more byte atomically', () => {
    const snapshot = sizedSnapshot('src/a', MAX_FROZEN_CONTEXT_BYTES);
    expect(contextBytes(snapshot.text)).toBe(MAX_FROZEN_CONTEXT_BYTES);
    const tab = buffer(body(snapshot) + 'x', 'src/a');
    const before = structuredClone(tab);
    expect(() => createEditorSnapshot(root, tab)).toThrow(
      /64 KiB.*smaller selection/,
    );
    expect(tab).toEqual(before);
  });

  it('enforces the same limit for Unicode and selections without truncation', () => {
    const base = selection('src/a', 1, 1, 'x');
    const available = MAX_FROZEN_CONTEXT_BYTES - contextBytes(base.text) + 1;
    const exact =
      '🦊'.repeat(Math.floor(available / 4)) + 'x'.repeat(available % 4);
    const captured = selection('src/a', 1, 1, exact);
    expect(contextBytes(captured.text)).toBe(MAX_FROZEN_CONTEXT_BYTES);
    expect(body(captured)).toBe(exact);
    expect(() => selection('src/a', 1, 1, exact + 'é')).toThrow(/64 KiB/);
    const snapshotBase = createEditorSnapshot(root, buffer('', 'src/雪.ts'));
    const remaining =
      MAX_FROZEN_CONTEXT_BYTES - contextBytes(snapshotBase.text);
    const text =
      '雪'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3);
    expect(body(createEditorSnapshot(root, buffer(text, 'src/雪.ts')))).toBe(
      text,
    );
    expect(() =>
      createEditorSnapshot(root, buffer(text + 'x', 'src/雪.ts')),
    ).toThrow(/64 KiB/);
  });

  it('allows four mixed frozen contexts and keeps the original draft on overflow', () => {
    const existing = [
      selection('src/a'),
      selection('src/b'),
      createEditorSnapshot(root, buffer('', 'src/c')),
      createEditorSnapshot(root, buffer('', 'src/d')),
    ];
    const before = [...existing];
    expect(existing).toHaveLength(MAX_FROZEN_CONTEXTS);
    expect(() => addFileContext(existing, selection('src/e'))).toThrow(
      /at most 4/,
    );
    expect(existing).toEqual(before);
    expect(
      addFileContext(existing, selection('src/a', 2, 3, 'replacement\ntext')),
    ).toHaveLength(MAX_FROZEN_CONTEXTS);
  });

  it('allows exactly 128 KiB aggregate frozen text and applies replacement deltas', () => {
    const first = sizedSnapshot('src/a', MAX_FROZEN_CONTEXT_BYTES);
    const second = sizedSnapshot('src/b', MAX_FROZEN_CONTEXT_BYTES);
    let contexts = addFileContext([first], second);
    expect(
      contexts.reduce((sum, context) => sum + contextBytes(context.text), 0),
    ).toBe(MAX_FROZEN_TOTAL_BYTES);
    expect(() => addFileContext(contexts, selection('src/c'))).toThrow(
      /128 KiB/,
    );
    expect(contexts).toEqual([first, second]);
    contexts = addFileContext(
      contexts,
      createEditorSnapshot(root, buffer('', 'src/b')),
    );
    expect(contexts).toHaveLength(2);
    expect(body(contexts[1])).toBe('');
    expect(addFileContext(contexts, selection('src/c'))).toHaveLength(3);
    const third = selection('src/c');
    const limited = [
      first,
      sizedSnapshot(
        'src/b',
        MAX_FROZEN_CONTEXT_BYTES - contextBytes(third.text),
      ),
      third,
    ];
    expect(
      limited.reduce((sum, context) => sum + contextBytes(context.text), 0),
    ).toBe(MAX_FROZEN_TOTAL_BYTES);
    const before = [...limited];
    expect(() => addFileContext(limited, second)).toThrow(/128 KiB/);
    expect(limited).toEqual(before);
  });

  it('enforces the per-context limit again when adding a reconstructed draft item', () => {
    const snapshot = sizedSnapshot('src/a', MAX_FROZEN_CONTEXT_BYTES);
    expect(() =>
      addFileContext([], { ...snapshot, text: snapshot.text + 'x' }),
    ).toThrow(/64 KiB/);
  });

  it('allows 16 mixed file/folder references, replacement at the cap, and independent frozen contexts', () => {
    const references = Array.from({ length: MAX_FILE_REFERENCES }, (_, index) =>
      createFileReference(root, `path-${index}`, index % 2 === 0),
    );
    const replacement = createFileReference(root, 'path-0');
    expect(addFileContext(references, replacement)).toHaveLength(16);
    expect(addFileContext(references, replacement)[0]).toBe(replacement);
    expect(() =>
      addFileContext(references, createFileReference(root, 'overflow')),
    ).toThrow(/at most 16/);
    expect(references).toHaveLength(16);
    expect(addFileContext(references, selection())).toHaveLength(17);
  });

  it('replaces the same selection range while retaining other ranges and source kinds', () => {
    const reference = createFileReference(root, 'src/main.ts');
    const snapshot = createEditorSnapshot(root, buffer('whole buffer'));
    const first = selection();
    const other = selection('src/main.ts', 4, 5);
    const replacement = selection('src/main.ts', 2, 3, 'new\nselection');
    const before = [reference, first, snapshot, other];
    const next = addFileContext(before, replacement);
    expect(next).toEqual([reference, replacement, snapshot, other]);
    expect(before).toEqual([reference, first, snapshot, other]);
    expect(body(first)).toBe('a\nb');
  });

  it('preserves generic quote/diff contexts even with colliding IDs or large bodies', () => {
    const snapshot = createEditorSnapshot(root, buffer('new'));
    const quote = {
      id: snapshot.id,
      label: 'Quoted text',
      text: 'q'.repeat(MAX_FROZEN_TOTAL_BYTES),
    };
    const diff = { id: 'diff:src/main.ts', label: 'Diff', text: 'patch' };
    const next = addFileContext([quote, diff], snapshot);
    expect(next).toEqual([quote, diff, snapshot]);
    expect(next[0]).toBe(quote);
    expect(next[1]).toBe(diff);
    const secondQuote = {
      id: quote.id,
      label: 'Another quote',
      text: 'another',
    };
    expect(addFileContext(next, secondQuote)).toEqual([...next, secondQuote]);
  });

  it('never mutates an input draft and removes only duplicate managed sources', () => {
    const old = createEditorSnapshot(root, buffer('before'));
    const quote = { id: 'quote', label: 'Quote', text: 'unchanged' };
    const existing = [old, quote, old];
    Object.freeze(existing);
    const replacement = createEditorSnapshot(root, buffer('after'));
    expect(addFileContext(existing, replacement)).toEqual([replacement, quote]);
    expect(existing).toEqual([old, quote, old]);
  });
});

it('freezes a reconstructed file context without mutating the caller object', () => {
  const original = createEditorSnapshot(root, buffer('captured'));
  const reconstructed = { ...original, file: { ...original.file! } };
  const next = addFileContext([], reconstructed);
  reconstructed.text = 'changed';
  reconstructed.file.path = 'renamed.ts';
  expect(next[0]).toEqual(original);
  expect(Object.isFrozen(next[0])).toBe(true);
  expect(Object.isFrozen(next[0].file)).toBe(true);
  expect(Object.isFrozen(reconstructed)).toBe(false);
});

it('rejects a file item with a corrupted identity instead of bypassing limits', () => {
  const snapshot = createEditorSnapshot(root, buffer('captured'));
  expect(() => addFileContext([], { ...snapshot, id: 'generic' })).toThrow(
    /invalid source identity/,
  );
});

describe('recovered draft validation', () => {
  it('rejects combined recovery above the frozen count cap without losing any items', () => {
    const original = Array.from({ length: 4 }, (_, index) =>
      selection(`old-${index}`),
    );
    const newContext = selection('new');
    const recovered = [...original, newContext];
    const before = [...recovered];
    expect(() => assertFileContextDraft(original, root)).not.toThrow();
    expect(() => assertFileContextDraft([newContext], root)).not.toThrow();
    Object.freeze(recovered);
    expect(() => assertFileContextDraft(recovered, root)).toThrow(/at most 4/);
    expect(recovered).toEqual(before);
    expect(recovered.at(-1)).toBe(newContext);
  });

  it('rejects combined recovery above byte and reference caps without mutation', () => {
    const first = sizedSnapshot('a', MAX_FROZEN_CONTEXT_BYTES);
    const second = sizedSnapshot('b', MAX_FROZEN_CONTEXT_BYTES);
    const recovered = [first, second, selection('c')];
    const before = [...recovered];
    expect(() => assertFileContextDraft([first, second], root)).not.toThrow();
    expect(() => assertFileContextDraft(recovered, root)).toThrow(/128 KiB/);
    expect(recovered).toEqual(before);
    const references = Array.from({ length: 17 }, (_, index) =>
      createFileReference(root, `file-${index}`),
    );
    expect(() => assertFileContextDraft(references, root)).toThrow(
      /at most 16/,
    );
    expect(references).toHaveLength(17);
  });

  it('counts repeated recovered items as-is rather than deduplicating during validation', () => {
    const snapshot = createEditorSnapshot(root, buffer());
    const recovered = Array<Context>(5).fill(snapshot);
    expect(() => assertFileContextDraft(recovered)).toThrow(/at most 4/);
    expect(recovered).toHaveLength(5);
  });

  it('rejects all foreign-project sources while preserving the draft', () => {
    for (const foreign of [
      createFileReference('/other', 'a'),
      createEditorSnapshot('/other', buffer()),
      createSelectionContext('/other', {
        path: 'a',
        text: 'selection',
        fromLine: 1,
        toLine: 1,
        dirty: false,
      }),
    ]) {
      const draft = [createFileReference(root, 'local'), foreign];
      const before = [...draft];
      expect(() => assertFileContextDraft(draft)).not.toThrow();
      expect(() => assertFileContextDraft(draft, root)).toThrow(
        /another project.*Remove it/,
      );
      expect(draft).toEqual(before);
    }
  });

  it('normalizes expected-root trailing slashes consistently with captured sources', () => {
    const contexts = [
      createFileReference(root + '///', 'a'),
      createEditorSnapshot(root, buffer()),
      selection(),
    ];
    expect(() => assertFileContextDraft(contexts, root + '///')).not.toThrow();
    expect(() =>
      assertFileContextDraft([createFileReference('/', 'a')], '///'),
    ).not.toThrow();
  });

  it('rejects corrupted identities among existing recovered items as well as new additions', () => {
    const original = createEditorSnapshot(root, buffer());
    const invalid = { ...original, id: 'broken' };
    expect(() => assertFileContextDraft([invalid], root)).toThrow(
      /invalid source identity/,
    );
    expect(() => addFileContext([invalid], selection('new'))).toThrow(
      /invalid source identity/,
    );
    expect(invalid.id).toBe('broken');
    const invalidPath = {
      ...original,
      file: { ...original.file!, path: '../escape' },
    };
    expect(() => assertFileContextDraft([invalidPath], root)).toThrow(
      /invalid source identity/,
    );
  });

  it('permits generic quote/diff contexts regardless of their size and namespace-like IDs', () => {
    const source = createFileReference('/other', 'a');
    const quote = {
      id: source.id,
      label: 'Quote',
      text: 'x'.repeat(MAX_FROZEN_TOTAL_BYTES + 1),
    };
    const diff = { id: 'diff:a', label: 'Diff', text: 'patch' };
    const generic = [quote, diff];
    expect(() => assertFileContextDraft(generic, root)).not.toThrow();
    expect(() =>
      assertFileContextDraft(
        [...generic, createFileReference(root, 'a')],
        root,
      ),
    ).not.toThrow();
    expect(generic).toEqual([quote, diff]);
  });
});

describe('exact selection ranges', () => {
  function exact(text: string, fromOffset: number, toOffset: number) {
    return createSelectionContext(root, {
      path: 'src/main.ts',
      text,
      fromLine: 1,
      toLine: 1,
      fromOffset,
      toOffset,
      dirty: true,
    });
  }

  it('keeps disjoint partial selections on the same line even when their text matches', () => {
    const first = exact('foo', 0, 3);
    const second = exact('foo', 4, 7);
    expect(first.id).not.toBe(second.id);
    expect(first.label).toBe(second.label);
    expect(addFileContext([first], second)).toEqual([first, second]);
    expect(first.file).toMatchObject({
      fromLine: 1,
      toLine: 1,
      fromOffset: 0,
      toOffset: 3,
    });
    expect(second.file).toMatchObject({ fromOffset: 4, toOffset: 7 });
    expect(first.text).toContain('Editor offsets (UTF-16, end exclusive): 0–3');
    expect(body(first)).toBe('foo');
    expect(() => assertFileContextDraft([first, second], root)).not.toThrow();
  });

  it('replaces only an explicitly re-added exact range while preserving other ranges', () => {
    const first = exact('foo', 0, 3);
    const second = exact('bar', 4, 7);
    const replacement = exact('new', 0, 3);
    const snapshot = createEditorSnapshot(root, buffer('full file'));
    const other = selection('other.ts');
    const existing = [first, second, snapshot, other];
    expect(replacement.id).toBe(first.id);
    expect(addFileContext(existing, replacement)).toEqual([
      replacement,
      second,
      snapshot,
      other,
    ]);
    expect(body(first)).toBe('foo');
    expect(existing[0]).toBe(first);
  });

  it('retains legacy line-range identity without colliding with an exact range', () => {
    const legacy = selection('src/main.ts', 1, 1, 'old');
    const legacyReplacement = selection('src/main.ts', 1, 1, 'new');
    const captured = exact('old', 0, 3);
    expect(legacyReplacement.id).toBe(legacy.id);
    expect(captured.id).not.toBe(legacy.id);
    expect(legacy.file).not.toHaveProperty('fromOffset');
    expect(legacy.text).not.toContain('Editor offsets');
    expect(addFileContext([legacy, captured], legacyReplacement)).toEqual([
      legacyReplacement,
      captured,
    ]);
  });

  it('measures offsets in UTF-16 editor positions, independently of UTF-8 byte limits', () => {
    const text = '🦊雪';
    expect(text.length).toBe(3);
    expect(contextBytes(text)).toBe(7);
    const captured = exact(text, 8, 11);
    expect(body(captured)).toBe(text);
    expect(captured.file).toMatchObject({ fromOffset: 8, toOffset: 11 });
    expect(() => exact(text, 8, 15)).toThrow(/does not match.*editor offsets/);
  });

  it.each([
    [undefined, 3],
    [0, undefined],
    [-1, 2],
    [1.5, 4.5],
    [3, 3],
    [3, 0],
    [NaN, 3],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])(
    'rejects invalid or partial offset pairs %s–%s',
    (fromOffset, toOffset) => {
      expect(() =>
        createSelectionContext(root, {
          path: 'src/main.ts',
          text: 'foo',
          fromLine: 1,
          toLine: 1,
          fromOffset,
          toOffset,
          dirty: false,
        }),
      ).toThrow(/valid editor offsets/);
    },
  );

  it('rejects mismatched captured text and corrupted recovered offset metadata', () => {
    expect(() => exact('foo', 0, 4)).toThrow(/does not match.*editor offsets/);
    const captured = exact('foo', 0, 3);
    const corrupted = { ...captured, file: { ...captured.file!, toOffset: 4 } };
    expect(() => assertFileContextDraft([corrupted], root)).toThrow(
      /invalid source identity/,
    );
    const partial = {
      ...captured,
      file: { ...captured.file!, fromOffset: undefined },
    };
    expect(() => assertFileContextDraft([partial], root)).toThrow(
      /invalid source identity/,
    );
  });

  it('freezes captured offsets independently of later selection changes', () => {
    const capture = {
      path: 'src/main.ts',
      text: 'foo',
      fromLine: 1,
      toLine: 1,
      fromOffset: 0,
      toOffset: 3,
      dirty: true,
    };
    const frozen = createSelectionContext(root, capture);
    capture.fromOffset = 4;
    capture.toOffset = 7;
    expect(frozen.file).toMatchObject({ fromOffset: 0, toOffset: 3 });
    expect(Object.isFrozen(frozen.file)).toBe(true);
    expect(() => Object.assign(frozen.file!, { fromOffset: 4 })).toThrow();
  });
});
