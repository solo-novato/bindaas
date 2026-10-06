import type { Context, Tab } from './types';

export const MAX_FROZEN_CONTEXT_BYTES = 64 * 1024;
export const MAX_FROZEN_TOTAL_BYTES = 128 * 1024;
export const MAX_FROZEN_CONTEXTS = 4;
export const MAX_FILE_REFERENCES = 16;

export type FileSelectionCapture = {
  path: string;
  text: string;
  fromLine: number;
  toLine: number;
  /** UTF-16 editor positions; the end is exclusive. Supply both or neither. */
  fromOffset?: number;
  toOffset?: number;
  dirty: boolean;
};

type FileSource = NonNullable<Context['file']>;
const encoder = new TextEncoder();

export function contextBytes(text: string): number {
  return encoder.encode(text).byteLength;
}

function canonicalProjectRoot(projectRoot: string): string {
  if (!projectRoot.startsWith('/') || projectRoot.includes('\0'))
    throw new Error('Choose a project before adding file context.');
  return projectRoot.replace(/\/+$/, '') || '/';
}

function sourcePath(projectRoot: string, path: string, directory = false) {
  const root = canonicalProjectRoot(projectRoot);
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').includes('..')
  )
    throw new Error('File context needs a path inside the active project.');
  const relative = path
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  if (!relative && !directory)
    throw new Error(
      'Choose a file to capture, rather than the project folder.',
    );
  return {
    projectRoot: root,
    path: relative || '.',
  };
}

function contextId(file: FileSource): string {
  return `bindaas:file-context:${JSON.stringify([
    file.kind,
    file.projectRoot,
    file.path,
    ...(file.kind === 'selection' ? [file.fromLine, file.toLine] : []),
    ...(file.kind === 'selection' && file.fromOffset !== undefined
      ? [file.fromOffset, file.toOffset]
      : []),
  ])}`;
}

function freezeContext(label: string, text: string, file: FileSource): Context {
  if (file.kind !== 'reference') assertFrozenSize(text);
  return Object.freeze({
    id: contextId(file),
    label,
    text,
    file: Object.freeze({ ...file }),
  });
}

function assertFrozenSize(text: string) {
  if (
    text.length > MAX_FROZEN_CONTEXT_BYTES ||
    contextBytes(text) > MAX_FROZEN_CONTEXT_BYTES
  )
    throw new Error(
      'A frozen context can be at most 64 KiB including its source header. Add a smaller selection or a file reference instead.',
    );
}

/** Paths are JSON-quoted so legal newlines and punctuation cannot forge headers. */
function locationHeader(file: FileSource): string {
  return `${file.directory ? 'Folder' : 'File'}: ${JSON.stringify(file.path)}`;
}

function snapshotText(file: FileSource, body: string): string {
  return [
    file.kind === 'selection'
      ? 'Frozen editor selection snapshot'
      : 'Frozen editor snapshot',
    locationHeader(file),
    ...(file.kind === 'selection'
      ? [`Lines: ${file.fromLine}–${file.toLine}`]
      : []),
    ...(file.kind === 'selection' && file.fromOffset !== undefined
      ? [
          `Editor offsets (UTF-16, end exclusive): ${file.fromOffset}–${file.toOffset}`,
        ]
      : []),
    `Unsaved edits at capture: ${file.dirty ? 'yes' : 'no'}`,
    'This is captured editor text and may include unsaved edits. Capturing it does not save or modify disk. It will not automatically refresh.',
    'Captured text follows verbatim:',
    '',
    body,
  ].join('\n');
}

/** A reference carries no file contents and never reads an editor buffer or disk. */
export function createFileReference(
  projectRoot: string,
  path: string,
  directory = false,
): Context {
  const file: FileSource = {
    kind: 'reference',
    ...sourcePath(projectRoot, path, directory),
    directory,
  };
  return freezeContext(
    file.path,
    `${directory ? 'Folder' : 'File'} reference (disk only)\n${locationHeader(file)}\nNo file contents are attached. This disk reference excludes unsaved editor text. Read from disk if needed under the conversation's existing permissions.`,
    file,
  );
}

/** Capture only the current buffer; never fall back to the last disk contents. */
export function createEditorSnapshot(projectRoot: string, tab: Tab): Context {
  const location = sourcePath(projectRoot, tab.path);
  if (!tab.data || tab.data.encoding !== 'utf8' || tab.data.content === null)
    throw new Error(
      'Only a readable text file can be captured. Open a text file or add a file reference instead.',
    );
  if (typeof tab.content !== 'string')
    throw new Error(
      'This file has no loaded editor buffer. Open it before capturing a snapshot, or add a file reference instead.',
    );
  if (tab.content.includes('\0'))
    throw new Error(
      'Binary content cannot be captured as text. Add a file reference instead.',
    );
  const file: FileSource = {
    kind: 'snapshot',
    ...location,
    dirty: tab.dirty,
  };
  return freezeContext(
    `${file.path} · editor snapshot`,
    snapshotText(file, tab.content),
    file,
  );
}

function validSelectionOffsets(source: {
  fromOffset?: number;
  toOffset?: number;
}): boolean {
  const { fromOffset, toOffset } = source;
  if (fromOffset === undefined && toOffset === undefined) return true;
  return (
    Number.isSafeInteger(fromOffset) &&
    Number.isSafeInteger(toOffset) &&
    fromOffset! >= 0 &&
    toOffset! > fromOffset!
  );
}

export function createSelectionContext(
  projectRoot: string,
  capture: FileSelectionCapture,
): Context {
  const location = sourcePath(projectRoot, capture.path);
  if (!capture.text.length)
    throw new Error(
      'Select some editor text before adding a selection snapshot.',
    );
  if (capture.text.includes('\0'))
    throw new Error(
      'Binary content cannot be captured as text. Add a file reference instead.',
    );
  assertFrozenSize(capture.text);
  const { fromLine, toLine, fromOffset, toOffset } = capture;
  if (!validSelectionOffsets(capture))
    throw new Error(
      'The selection needs valid editor offsets with an exclusive end. Supply both offsets or neither.',
    );
  if (
    fromOffset !== undefined &&
    toOffset! - fromOffset !== capture.text.length
  )
    throw new Error(
      'The selected text does not match its captured editor offsets.',
    );
  if (
    !Number.isSafeInteger(fromLine) ||
    !Number.isSafeInteger(toLine) ||
    fromLine < 1 ||
    toLine < fromLine
  )
    throw new Error('The selection needs a valid, ordered editor line range.');
  const breaks = (capture.text.match(/\r\n|\r|\n/g) ?? []).length;
  const span = toLine - fromLine;
  // Editors may report either side of an exclusive endpoint at a line break.
  if (span !== breaks && !(span === breaks - 1 && /[\r\n]$/.test(capture.text)))
    throw new Error(
      'The selection text does not match its captured line range.',
    );
  const file: FileSource = {
    kind: 'selection',
    ...location,
    fromLine,
    toLine,
    ...(fromOffset !== undefined ? { fromOffset, toOffset } : {}),
    dirty: capture.dirty,
  };
  return freezeContext(
    `${file.path} · lines ${fromLine}–${toLine}`,
    snapshotText(file, capture.text),
    file,
  );
}

function isManaged(context: Context): boolean {
  const file = context.file;
  if (!file || !['reference', 'snapshot', 'selection'].includes(file.kind))
    return false;
  try {
    const source = sourcePath(
      file.projectRoot,
      file.path,
      file.kind === 'reference' && file.directory === true,
    );
    if (source.projectRoot !== file.projectRoot || source.path !== file.path)
      return false;
  } catch {
    return false;
  }
  if (
    file.kind === 'selection' &&
    (!validSelectionOffsets(file) ||
      !Number.isSafeInteger(file.fromLine) ||
      !Number.isSafeInteger(file.toLine) ||
      file.fromLine! < 1 ||
      file.toLine! < file.fromLine!)
  )
    return false;
  return context.id === contextId(file);
}

/** Explicit re-add replaces only the same managed source, after all limits pass. */
export function addFileContext(existing: Context[], next: Context): Context[] {
  if (!next.file) return [...existing, next];
  if (!isManaged(next))
    throw new Error(
      'This file context has an invalid source identity. Add it again from Files.',
    );
  const replacing = (context: Context) =>
    isManaged(context) && context.id === next.id;
  const first = existing.findIndex(replacing);
  const result = existing.filter((context) => !replacing(context));
  // Keep the original chip's position so replacing a snapshot does not move it.
  const captured =
    Object.isFrozen(next) && Object.isFrozen(next.file)
      ? next
      : Object.freeze({ ...next, file: Object.freeze({ ...next.file }) });
  result.splice(first < 0 ? result.length : first, 0, captured);
  assertFileContextDraft(result);
  return result;
}

/** Validate recovered drafts as-is; never discard a context to satisfy a limit. */
export function assertFileContextDraft(
  contexts: Context[],
  projectRoot?: string,
): void {
  const expectedRoot =
    projectRoot === undefined ? undefined : canonicalProjectRoot(projectRoot);
  let references = 0;
  let frozenCount = 0;
  let frozenBytes = 0;
  for (const context of contexts) {
    if (!context.file) continue;
    if (!isManaged(context))
      throw new Error(
        'This file context has an invalid source identity. Add it again from Files.',
      );
    if (expectedRoot !== undefined && context.file.projectRoot !== expectedRoot)
      throw new Error(
        'This draft includes file context from another project. Remove it and add context from the active project.',
      );
    if (context.file.kind === 'reference') {
      references++;
    } else {
      assertFrozenSize(context.text);
      frozenCount++;
      frozenBytes += contextBytes(context.text);
    }
  }
  if (references > MAX_FILE_REFERENCES)
    throw new Error(
      'A draft can include at most 16 file or folder references. Remove a reference before adding another.',
    );
  if (frozenCount > MAX_FROZEN_CONTEXTS)
    throw new Error(
      'A draft can include at most 4 editor or selection snapshots. Remove a snapshot before adding another.',
    );
  if (frozenBytes > MAX_FROZEN_TOTAL_BYTES)
    throw new Error(
      'A draft can include at most 128 KiB of frozen text including source headers. Remove a snapshot or add a smaller selection.',
    );
}
