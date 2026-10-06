import { api } from '../api';
import { createFileReference } from '../fileContext';
import { ask } from '../dialog.svelte';
import {
  assertFileOperationAvailable,
  currentTab,
  editor,
  openFile,
  reserveFileOperation,
} from '../editor.svelte';
import {
  cancelEdit,
  explorer,
  noteExplorer,
  parentOf,
  refreshFolder,
  within,
  type ExplorerOperation,
} from '../explorer.svelte';
import type { TreeAction } from '../components/TreeMenu.svelte';
import type { Context, Entry } from '../types';

// Each mutation owns a project, UI operation, and (for rename/Trash) editor
// reservation. No response may act on a replacement project or inline edit.
export type ExplorerContext = {
  root: () => string | null;
  scope: () => object | null;
  ready: () => boolean;
  discovered: () => Entry[];
  setDiscovered: (entries: Entry[]) => void;
  expanded: () => string[];
  setExpanded: (paths: string[]) => void;
  open: (path: string) => Promise<void>;
  addContext: (context: Context) => boolean | void;
  fail: (message: string) => void;
};

let nextOperation = 0;

export function createExplorerActions(ctx: ExplorerContext) {
  let inlineScope: {
    edit: typeof explorer.editing;
    live: () => boolean;
  } | null = null;
  function projectScope() {
    const root = ctx.root(),
      project = ctx.scope();
    if (!root || !project || !ctx.ready()) return null;
    return {
      root,
      live: () => ctx.root() === root && ctx.scope() === project && ctx.ready(),
    };
  }
  function begin(
    kind: ExplorerOperation['kind'],
    path: string,
    message: string,
  ) {
    const scope = projectScope();
    if (!scope || explorer.busy) return null;
    const token = ++nextOperation;
    explorer.busy = true;
    explorer.error = '';
    explorer.operation = { token, kind, path, message };
    return {
      root: scope.root,
      live: () => scope.live() && explorer.operation?.token === token,
      finish() {
        // A stale finally must not release a newer operation's busy state.
        if (explorer.operation?.token !== token) return;
        explorer.busy = false;
        explorer.operation = null;
      },
    };
  }
  function selectedFolder() {
    const entry = ctx.discovered().find((e) => e.path === explorer.selected);
    if (!entry) return '';
    return entry.directory ? entry.path : parentOf(entry.path);
  }
  function startCreate(folder: string, directory: boolean) {
    const scope = projectScope();
    if (!scope || explorer.busy) return;
    if (folder && !ctx.expanded().includes(folder))
      ctx.setExpanded([...ctx.expanded(), folder]);
    explorer.error = '';
    explorer.editing = { mode: 'create', parent: folder, directory };
    inlineScope = { edit: explorer.editing, live: scope.live };
  }
  function dirtyWithin(path: string) {
    return editor.tabs.find((tab) => tab.dirty && within(tab.path, path));
  }
  function available(path: string) {
    try {
      assertFileOperationAvailable(path);
      return true;
    } catch (error) {
      ctx.fail(String(error).replace(/^Error: /, ''));
      return false;
    }
  }
  async function treeAction(entry: Entry | null, action: TreeAction) {
    const scope = projectScope();
    if (!scope) return;
    const folder = !entry
      ? ''
      : entry.directory
        ? entry.path
        : parentOf(entry.path);
    if (action === 'new-file' || action === 'new-folder')
      return startCreate(folder, action === 'new-folder');
    if (!entry) return;
    const name = entry.path.split('/').at(-1) ?? entry.path;
    switch (action) {
      case 'open':
        return ctx.open(entry.path);
      case 'open-default':
        return api.openDefault(entry.path);
      case 'reveal':
        return api.reveal(entry.path);
      case 'copy-path':
      case 'copy-absolute':
        await navigator.clipboard.writeText(
          action === 'copy-path' ? entry.path : `${scope.root}/${entry.path}`,
        );
        if (scope.live()) noteExplorer('Path copied');
        return;
      case 'add-chat':
        if (
          ctx.addContext(
            createFileReference(scope.root, entry.path, entry.directory),
          ) === false
        )
          return;
        return noteExplorer(`Added ${name} as a file reference`);
      case 'rename': {
        if (explorer.busy) return;
        const dirty = dirtyWithin(entry.path);
        if (dirty)
          return ctx.fail(
            `Save or discard your edits to ${dirty.path} before renaming it.`,
          );
        if (!available(entry.path)) return;
        explorer.error = '';
        explorer.editing = {
          mode: 'rename',
          parent: parentOf(entry.path),
          path: entry.path,
          name,
        };
        inlineScope = { edit: explorer.editing, live: scope.live };
        return;
      }
      case 'trash': {
        if (explorer.busy) return;
        const dirty = dirtyWithin(entry.path);
        if (dirty)
          return ctx.fail(
            `Save or discard your edits to ${dirty.path} before moving it to the Trash.`,
          );
        if (!available(entry.path)) return;
        const operation = begin(
          'trash',
          entry.path,
          `Confirm moving ${name} to Trash`,
        );
        if (!operation) return;
        const edit = explorer.editing;
        const current = () => operation.live() && explorer.editing === edit;
        let reservation: ReturnType<typeof reserveFileOperation> | undefined;
        try {
          const choice = await ask(
            `Move ‘${name}’ to the Trash?`,
            entry.directory
              ? 'The folder and everything in it move to the Trash. You can drag them back out of the Trash to restore them.'
              : 'You can drag it back out of the Trash to restore it.',
            ['Move to Trash', 'Cancel'],
          );
          if (!current() || choice !== 'Move to Trash') return;
          // Recheck after confirmation: the user can keep typing in the meantime.
          reservation = reserveFileOperation(entry.path, 'trash');
          explorer.operation!.message = `Moving ${name} to Trash…`;
          await api.trashEntry(entry.path, operation.root);
          if (!operation.live()) return;
          const successor = reservation.trash();
          reservation.release();
          reservation = undefined;
          if (!current()) return;
          forgetPath(entry.path);
          refreshFolder(parentOf(entry.path));
          if (within(explorer.selected, entry.path)) explorer.selected = '';
          if (successor && editor.tabs.includes(successor)) {
            await openFile(successor.path);
            if (!current()) return;
          }
          if (
            edit &&
            within(edit.mode === 'rename' ? edit.path : edit.parent, entry.path)
          )
            cancelEdit();
          noteExplorer(`Moved ${name} to the Trash`);
        } catch (error) {
          if (current()) explorer.error = String(error).replace(/^Error: /, '');
        } finally {
          reservation?.release();
          operation.finish();
        }
        return;
      }
    }
  }
  function forgetPath(path: string) {
    ctx.setDiscovered(ctx.discovered().filter((e) => !within(e.path, path)));
    ctx.setExpanded(ctx.expanded().filter((f) => !within(f, path)));
  }
  async function commitName(name: string) {
    const edit = explorer.editing;
    if (!edit || inlineScope?.edit !== edit || !inlineScope.live()) return;
    const path = edit.mode === 'rename' ? edit.path : edit.parent;
    const operation = begin(
      edit.mode,
      path,
      edit.mode === 'rename' ? `Renaming ${edit.name}…` : `Creating ${name}…`,
    );
    if (!operation) return;
    let expectedEdit: typeof explorer.editing = edit;
    const current = () => operation.live() && explorer.editing === expectedEdit;
    let reservation: ReturnType<typeof reserveFileOperation> | undefined;
    try {
      if (edit.mode === 'create') {
        const path = await api.createEntry(
          edit.parent,
          name,
          edit.directory,
          operation.root,
        );
        if (!current()) return;
        cancelEdit();
        expectedEdit = explorer.editing;
        // Nested names ("ui/Button.svelte") reveal every folder they created.
        const folders: string[] = [];
        for (
          let folder = edit.directory ? path : parentOf(path);
          folder && folder !== edit.parent;
          folder = parentOf(folder)
        )
          folders.push(folder);
        ctx.setExpanded([...new Set([...ctx.expanded(), ...folders])]);
        refreshFolder(edit.parent);
        explorer.selected = path;
        if (!edit.directory) {
          const opening = ctx.open(path);
          const tab = editor.tabs.find((t) => t.path === path);
          await opening;
          if (!current()) return;
          if (tab && currentTab() === tab && tab.path === path)
            tab.editing = true;
        }
        noteExplorer(`Created ${path}`);
      } else {
        const destination = [
          edit.parent,
          ...name.trim().split('/').filter(Boolean),
        ]
          .filter(Boolean)
          .join('/');
        reservation = reserveFileOperation(edit.path, 'rename', destination);
        const next = await api.renameEntry(edit.path, name, operation.root);
        if (!operation.live()) return;
        reservation.rename(next);
        if (!current()) return;
        cancelEdit();
        expectedEdit = explorer.editing;
        const renamed = (path: string) => next + path.slice(edit.path.length);
        const wasExpanded = ctx.expanded().filter((f) => within(f, edit.path));
        forgetPath(edit.path);
        ctx.setExpanded([
          ...new Set([...ctx.expanded(), ...wasExpanded.map(renamed)]),
        ]);
        refreshFolder(edit.parent);
        explorer.selected = next;
        noteExplorer(`Renamed to ${next.split('/').at(-1)}`);
      }
    } catch (error) {
      if (current()) explorer.error = String(error).replace(/^Error: /, '');
    } finally {
      reservation?.release();
      operation.finish();
    }
  }
  return { selectedFolder, startCreate, treeAction, commitName };
}
