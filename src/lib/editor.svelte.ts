import { api } from './api';
import { editorText, diskText } from './text';
import { ask } from './dialog.svelte';
import type { Tab } from './types';
export const editor = $state<{
  tabs: Tab[];
  active: string;
  loading: boolean;
  error: string;
}>({ tabs: [], active: '', loading: false, error: '' });
export const currentTab = () =>
  editor.tabs.find((t) => t.path === editor.active);
let opening = 0;
export async function openFile(path: string) {
  const ticket = ++opening;
  editor.loading = true;
  editor.error = '';
  try {
    let tab = editor.tabs.find((t) => t.path === path);
    if (!tab) {
      tab = {
        path,
        dirty: false,
        editing: false,
        mode: 'edit',
        cursor: 0,
        scroll: 0,
      };
      editor.tabs.push(tab);
      tab = editor.tabs.at(-1)!;
    }
    if (!tab.data || tab.content === undefined) {
      const data = await api.read(path);
      if (ticket !== opening) return;
      tab.data = data;
      tab.content = data.content == null ? undefined : editorText(data.content);
    }
    editor.active = path;
    // Clean inactive tabs keep metadata only. Dirty buffers remain intact.
    for (const other of editor.tabs) {
      if (other.path !== path && !other.dirty) {
        other.content = undefined;
        if (other.data) other.data = { ...other.data, content: null };
      }
    }
  } catch (e) {
    editor.error = String(e);
  } finally {
    if (ticket === opening) editor.loading = false;
  }
}
export function editContent(content: string) {
  const tab = currentTab();
  if (tab) {
    tab.content = content;
    tab.dirty = content !== editorText(tab.data?.content ?? '');
  }
}
export async function saveTab(tab = currentTab()): Promise<boolean> {
  if (!tab?.data || tab.content === undefined) return false;
  try {
    const content = tab.content;
    const data = await api.save(
      tab.path,
      tab.data.fingerprint,
      diskText(content, tab.data.newline),
    );
    tab.data = data;
    tab.dirty = tab.content !== content;
    tab.conflict = undefined;
    return true;
  } catch (e) {
    tab.conflict = String(e);
    editor.error = String(e);
    return false;
  }
}
export async function closeTab(path: string): Promise<boolean> {
  const tab = editor.tabs.find((t) => t.path === path);
  if (!tab) return true;
  if (tab.dirty) {
    const choice = await ask(
      'Unsaved changes',
      `Save your changes to ${path}?`,
      ['Save', 'Don’t Save', 'Cancel'],
    );
    if (choice === 'Cancel') return false;
    if (choice === 'Save' && !(await saveTab(tab))) return false;
  }
  editor.tabs = editor.tabs.filter((t) => t !== tab);
  if (editor.active === path) {
    editor.active = '';
    const next = editor.tabs.at(-1);
    if (next) await openFile(next.path);
  }
  return true;
}
export async function protectDirty(): Promise<boolean> {
  for (const tab of [...editor.tabs])
    if (tab.dirty && !(await closeTab(tab.path))) return false;
  return true;
}
export async function checkFiles() {
  await Promise.allSettled(
    editor.tabs.map(async (tab) => {
      if (!tab.data) return;
      try {
        const fingerprint = await api.stat(tab.path);
        if (
          fingerprint.hash !== tab.data.fingerprint.hash ||
          fingerprint.modifiedNanos !== tab.data.fingerprint.modifiedNanos
        ) {
          if (tab.dirty) {
            tab.conflict = 'File changed on disk while you have unsaved edits';
          } else {
            tab.content = undefined;
            tab.data = { ...tab.data, content: null, fingerprint };
            if (editor.active === tab.path) await openFile(tab.path);
          }
        }
      } catch (e) {
        tab.conflict = String(e);
      }
    }),
  );
}
export async function reloadTab() {
  const tab = currentTab();
  if (!tab) return;
  if (
    tab.dirty &&
    (await ask(
      'Reload disk version?',
      `Your unsaved changes to ${tab.path} will be discarded.`,
      ['Reload', 'Cancel'],
    )) !== 'Reload'
  )
    return;
  tab.dirty = false;
  tab.content = undefined;
  tab.conflict = undefined;
  await openFile(tab.path);
}
