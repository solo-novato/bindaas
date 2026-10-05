import { api } from './api';
import { editorText, diskText } from './text';
import { ask } from './dialog.svelte';
import type { FileData, Tab } from './types';
export const editor = $state<{
  tabs: Tab[];
  active: string;
  loading: boolean;
  error: string;
}>({ tabs: [], active: '', loading: false, error: '' });
export const currentTab = () =>
  editor.tabs.find((t) => t.path === editor.active);
let opening = 0;
let openingTab: Tab | undefined;
const revisions = new WeakMap<Tab, number>();
const closing = new WeakSet<Tab>();
const live = (tab: Tab, path: string) =>
  tab.path === path && editor.tabs.includes(tab);
const busy = (tab: Tab) => tab.saving || tab.reloading;
/** Call only after the caller has protected the current project's dirty buffers. */
export function resetEditor() {
  opening++;
  openingTab = undefined;
  editor.tabs = [];
  editor.active = '';
  editor.loading = false;
  editor.error = '';
}
function snapshot(tab: Tab) {
  const path = tab.path,
    content = tab.content,
    data = tab.data,
    revision = revisions.get(tab),
    ticket = opening;
  return {
    path,
    content,
    data,
    live: () => live(tab, path),
    unchanged: () =>
      live(tab, path) &&
      tab.content === content &&
      tab.data === data &&
      revisions.get(tab) === revision,
    visible: () =>
      live(tab, path) && currentTab() === tab && opening === ticket,
  };
}
function requireText(
  data: FileData,
  path: string,
): asserts data is FileData & { content: string } {
  if (data.path !== path)
    throw new Error('File response did not match this tab');
  if (data.encoding !== 'utf8' || typeof data.content !== 'string')
    throw new Error(
      'Disk version is not available as UTF-8 text. Your buffer is unchanged.',
    );
}
function report(tab: Tab, scope: ReturnType<typeof snapshot>, error: unknown) {
  if (!scope.live()) return;
  tab.conflict = String(error);
  if (scope.visible()) editor.error = String(error);
}
export async function openFile(path: string) {
  const ticket = ++opening;
  editor.loading = true;
  editor.error = '';
  let tab = editor.tabs.find((t) => t.path === path);
  if (!tab) {
    editor.tabs.push({
      path,
      dirty: false,
      editing: false,
      mode: 'edit',
      cursor: 0,
      scroll: 0,
    });
    tab = editor.tabs.at(-1)!;
  }
  openingTab = tab;
  const scope = snapshot(tab);
  try {
    // Never replace a dirty buffer just because its disk metadata is missing.
    if ((!tab.data || tab.content === undefined) && !tab.dirty && !busy(tab)) {
      const data = await api.read(path);
      if (ticket !== opening || !scope.unchanged() || tab.dirty || busy(tab))
        return;
      if (data.path !== path)
        throw new Error('File response did not match this tab');
      if (scope.content !== undefined) requireText(data, path);
      tab.data = data;
      tab.content = data.content == null ? undefined : editorText(data.content);
    }
    if (ticket !== opening || !scope.live()) return;
    editor.active = path;
    // Pending operations retain their captured buffers until they settle too.
    for (const other of editor.tabs) {
      if (other !== tab && !other.dirty && !busy(other)) {
        other.content = undefined;
        if (other.data) other.data = { ...other.data, content: null };
      }
    }
  } catch (e) {
    if (ticket === opening && scope.live()) editor.error = String(e);
  } finally {
    if (ticket === opening) {
      editor.loading = false;
      openingTab = undefined;
    }
  }
}
export function editContent(content: string) {
  const tab = currentTab();
  if (tab) {
    if (tab.content !== content)
      revisions.set(tab, (revisions.get(tab) ?? 0) + 1);
    tab.content = content;
    // A conflict (including an uncertain write ACK) invalidates the old baseline.
    tab.dirty =
      !!tab.saving ||
      !!tab.conflict ||
      content !== editorText(tab.data?.content ?? '');
  }
}
async function writeTab(
  tab: Tab,
  scope: ReturnType<typeof snapshot>,
  disk: FileData,
): Promise<boolean> {
  if (!scope.unchanged() || scope.content === undefined) return false;
  const data = await api.save(
    scope.path,
    { ...disk.fingerprint },
    diskText(scope.content, disk.newline),
  );
  if (!scope.live() || tab.data !== scope.data) return false;
  requireText(data, scope.path);
  // The backend rereads after writing; an immediate external edit is a conflict.
  if (editorText(data.content) !== editorText(scope.content))
    throw new Error('File changed again during save; compare before saving');
  tab.data = data;
  tab.dirty = tab.content !== editorText(data.content);
  tab.conflict = undefined;
  if (scope.visible()) editor.error = '';
  return true;
}
export async function saveTab(tab = currentTab()): Promise<boolean> {
  if (
    !tab?.data ||
    tab.content === undefined ||
    busy(tab) ||
    !live(tab, tab.path)
  )
    return false;
  const scope = snapshot(tab);
  tab.saving = true;
  try {
    requireText(tab.data, scope.path);
    return await writeTab(tab, scope, tab.data);
  } catch (e) {
    if (scope.live()) tab.dirty = true;
    report(tab, scope, e);
    return false;
  } finally {
    tab.saving = false;
  }
}
export async function saveComparedTab(
  tab: Tab,
  disk: FileData,
): Promise<'saved' | 'cancelled' | 'failed'> {
  if (
    !tab.data ||
    tab.content === undefined ||
    busy(tab) ||
    !live(tab, tab.path)
  )
    return 'cancelled';
  const scope = snapshot(tab);
  tab.saving = true;
  try {
    requireText(tab.data, scope.path);
    requireText(disk, scope.path);
    // Approval applies to exactly the comparison the user reviewed.
    const compared = { ...disk, fingerprint: { ...disk.fingerprint } };
    const choice = await ask(
      'Save your version?',
      `Replace the compared disk version of ${scope.path} with your current content? If the file changes again, saving will be refused.`,
      ['Save my version', 'Cancel'],
    );
    if (choice !== 'Save my version' || !scope.live()) return 'cancelled';
    if (!scope.unchanged()) {
      report(
        tab,
        scope,
        'Your content changed. Compare again before saving your version.',
      );
      return 'failed';
    }
    return (await writeTab(tab, scope, compared)) ? 'saved' : 'cancelled';
  } catch (e) {
    if (scope.live()) tab.dirty = true;
    report(tab, scope, e);
    return 'failed';
  } finally {
    tab.saving = false;
  }
}
export async function closeTab(path: string): Promise<boolean> {
  const tab = editor.tabs.find((t) => t.path === path);
  if (!tab) return true;
  if (busy(tab) || closing.has(tab)) return false;
  const scope = snapshot(tab);
  closing.add(tab);
  try {
    if (tab.dirty) {
      const choice = await ask(
        'Unsaved changes',
        `Save your changes to ${path}?`,
        ['Save', 'Don’t Save', 'Cancel'],
      );
      if (!scope.unchanged() || busy(tab)) return false;
      if (choice === 'Save') {
        if (!(await saveTab(tab)) || tab.dirty || !scope.live()) return false;
      } else if (choice !== 'Don’t Save') return false;
    }
    if (!scope.live()) return false;
    editor.tabs = editor.tabs.filter((t) => t !== tab);
    if (openingTab === tab) {
      opening++;
      openingTab = undefined;
      editor.loading = false;
    }
    if (editor.active === path) {
      editor.active = '';
      const next = editor.tabs.at(-1);
      if (next) await openFile(next.path);
    }
    return true;
  } finally {
    closing.delete(tab);
  }
}
export async function protectDirty(): Promise<boolean> {
  for (const tab of [...editor.tabs])
    if (tab.dirty && !(await closeTab(tab.path))) return false;
  // A clean or newly opened tab may have been edited while a dialog was open.
  return !editor.tabs.some((tab) => tab.dirty || busy(tab));
}
export async function checkFiles() {
  await Promise.allSettled(
    editor.tabs.map(async (tab) => {
      if (!tab.data || busy(tab)) return;
      const scope = snapshot(tab);
      try {
        const fingerprint = await api.stat(scope.path);
        if (!scope.live() || tab.data !== scope.data || busy(tab)) return;
        if (
          fingerprint.hash !== tab.data!.fingerprint.hash ||
          fingerprint.modifiedNanos !== tab.data!.fingerprint.modifiedNanos ||
          fingerprint.sizeBytes !== tab.data!.fingerprint.sizeBytes
        ) {
          if (tab.dirty) {
            tab.conflict = 'File changed on disk while you have unsaved edits';
          } else if (currentTab() === tab) {
            await reloadTab(tab);
          } else {
            tab.content = undefined;
            tab.data = { ...tab.data!, content: null };
          }
        }
      } catch (e) {
        if (scope.live() && tab.data === scope.data && !busy(tab))
          tab.conflict = String(e);
      }
    }),
  );
}
export async function reloadTab(tab = currentTab()): Promise<boolean> {
  if (!tab || busy(tab) || !live(tab, tab.path)) return false;
  const scope = snapshot(tab);
  tab.reloading = true;
  try {
    if (
      tab.dirty &&
      (await ask(
        'Reload disk version?',
        `Your unsaved changes to ${scope.path} will be discarded.`,
        ['Reload', 'Cancel'],
      )) !== 'Reload'
    )
      return false;
    if (!scope.unchanged()) return false;
    const data = await api.read(scope.path);
    if (!scope.unchanged()) return false;
    requireText(data, scope.path);
    tab.data = data;
    tab.content = editorText(data.content);
    tab.dirty = false;
    tab.conflict = undefined;
    if (scope.visible()) editor.error = '';
    return true;
  } catch (e) {
    report(tab, scope, e);
    return false;
  } finally {
    tab.reloading = false;
  }
}
