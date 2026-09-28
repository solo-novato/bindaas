// Shared explorer UI state: selection, the inline create/rename field, and
// per-folder refresh signals so a change reloads only the folder it touched.
export type ExplorerEdit =
  | { mode: 'create'; parent: string; directory: boolean }
  | { mode: 'rename'; parent: string; path: string; name: string };

export const explorer = $state<{
  selected: string;
  editing: ExplorerEdit | null;
  error: string;
  busy: boolean;
  note: string;
  revisions: Record<string, number>;
}>({
  selected: '',
  editing: null,
  error: '',
  busy: false,
  note: '',
  revisions: {},
});

let noteTimer: ReturnType<typeof setTimeout> | undefined;
/** A short confirmation under the tree ("Path copied", "Created …"). */
export function noteExplorer(message: string) {
  explorer.note = message;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (explorer.note = ''), 2400);
}

export function parentOf(path: string) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function within(path: string, folder: string) {
  return path === folder || path.startsWith(`${folder}/`);
}

export function refreshFolder(path: string) {
  explorer.revisions[path] = (explorer.revisions[path] ?? 0) + 1;
}

export function cancelEdit() {
  explorer.editing = null;
  explorer.error = '';
}
