import { api } from '../api';
import { ask } from '../dialog.svelte';
import { closeTab, editor, openFile } from '../editor.svelte';
import {
  cancelEdit,
  explorer,
  noteExplorer,
  parentOf,
  refreshFolder,
  within,
} from '../explorer.svelte';
import type { TreeAction } from '../components/TreeMenu.svelte';
import type { Context, Entry } from '../types';

// Explorer file actions. Rust never overwrites anything; unsaved edits block
// rename and trash; only the touched folder reloads.

export type ExplorerContext = {
  root: () => string | null;
  discovered: () => Entry[];
  setDiscovered: (entries: Entry[]) => void;
  expanded: () => string[];
  setExpanded: (paths: string[]) => void;
  open: (path: string) => Promise<void>;
  addContext: (context: Context) => void;
  fail: (message: string) => void;
};

export function createExplorerActions(ctx: ExplorerContext) {
  function selectedFolder() {
    const entry = ctx.discovered().find((e) => e.path === explorer.selected);
    if (!entry) return '';
    return entry.directory ? entry.path : parentOf(entry.path);
  }
  function startCreate(folder: string, directory: boolean) {
    if (folder && !ctx.expanded().includes(folder))
      ctx.setExpanded([...ctx.expanded(), folder]);
    explorer.error = '';
    explorer.editing = { mode: 'create', parent: folder, directory };
  }
  function dirtyWithin(path: string) {
    return editor.tabs.find((tab) => tab.dirty && within(tab.path, path));
  }
  async function treeAction(entry: Entry | null, action: TreeAction) {
    const folder = !entry
      ? ''
      : entry.directory
        ? entry.path
        : parentOf(entry.path);
    if (action === 'new-file' || action === 'new-folder')
      return startCreate(folder, action === 'new-folder');
    const root = ctx.root();
    if (!entry || !root) return;
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
          action === 'copy-path' ? entry.path : `${root}/${entry.path}`,
        );
        return noteExplorer('Path copied');
      case 'add-chat':
        ctx.addContext({
          id: crypto.randomUUID(),
          label: entry.path,
          text: `${entry.directory ? 'Folder' : 'File'}: ${entry.path}`,
        });
        return noteExplorer(`Added ${name} to your message`);
      case 'rename': {
        const dirty = dirtyWithin(entry.path);
        if (dirty)
          return ctx.fail(
            `Save or discard your edits to ${dirty.path} before renaming it.`,
          );
        explorer.error = '';
        explorer.editing = {
          mode: 'rename',
          parent: parentOf(entry.path),
          path: entry.path,
          name,
        };
        return;
      }
      case 'trash': {
        const dirty = dirtyWithin(entry.path);
        if (dirty)
          return ctx.fail(
            `Save or discard your edits to ${dirty.path} before moving it to the Trash.`,
          );
        const choice = await ask(
          `Move ‘${name}’ to the Trash?`,
          entry.directory
            ? 'The folder and everything in it move to the Trash. You can drag them back out of the Trash to restore them.'
            : 'You can drag it back out of the Trash to restore it.',
          ['Move to Trash', 'Cancel'],
        );
        if (choice !== 'Move to Trash') return;
        await api.trashEntry(entry.path);
        for (const tab of editor.tabs.filter((t) => within(t.path, entry.path)))
          await closeTab(tab.path);
        forgetPath(entry.path);
        refreshFolder(parentOf(entry.path));
        explorer.selected = '';
        return noteExplorer(`Moved ${name} to the Trash`);
      }
    }
  }
  function forgetPath(path: string) {
    ctx.setDiscovered(ctx.discovered().filter((e) => !within(e.path, path)));
    ctx.setExpanded(ctx.expanded().filter((f) => !within(f, path)));
  }
  async function commitName(name: string) {
    const edit = explorer.editing;
    if (!edit || explorer.busy) return;
    explorer.busy = true;
    explorer.error = '';
    try {
      if (edit.mode === 'create') {
        const path = await api.createEntry(edit.parent, name, edit.directory);
        cancelEdit();
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
          await ctx.open(path);
          const tab = editor.tabs.find((t) => t.path === path);
          if (tab) tab.editing = true;
        }
        noteExplorer(`Created ${path}`);
      } else {
        const dirty = dirtyWithin(edit.path);
        if (dirty)
          throw new Error(`Save or discard your edits to ${dirty.path} first.`);
        const next = await api.renameEntry(edit.path, name);
        cancelEdit();
        const moved = editor.tabs.filter((t) => within(t.path, edit.path));
        const active = moved.find((t) => t.path === editor.active)?.path;
        for (const tab of moved) await closeTab(tab.path);
        const renamed = (path: string) => next + path.slice(edit.path.length);
        const wasExpanded = ctx.expanded().filter((f) => within(f, edit.path));
        forgetPath(edit.path);
        ctx.setExpanded([...ctx.expanded(), ...wasExpanded.map(renamed)]);
        refreshFolder(edit.parent);
        explorer.selected = next;
        if (active) await openFile(renamed(active));
        noteExplorer(`Renamed to ${next.split('/').at(-1)}`);
      }
    } catch (e) {
      explorer.error = String(e).replace(/^Error: /, '');
    } finally {
      explorer.busy = false;
    }
  }
  return { selectedFolder, startCreate, treeAction, commitName };
}
