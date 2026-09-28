import type { Tab } from './types';

const KEY = 'workbench.workspace.v1';
export type Workspace = {
  root: string;
  view: string;
  threadId: string | null;
  tabs: Pick<Tab, 'path' | 'mode' | 'cursor' | 'scroll'>[];
  activeFile: string;
  expanded: string[];
  leftOpen: boolean;
  rightOpen: boolean;
  showHidden: boolean;
  focusMode?: boolean;
};
type Saved = { lastProject: string; projects: Record<string, Workspace> };
export function readWorkspaces(storage: Pick<Storage, 'getItem'>): Saved {
  try {
    const data = JSON.parse(storage.getItem(KEY) ?? '{}');
    const projects: Record<string, Workspace> = {};
    for (const [root, value] of Object.entries(data.projects ?? {}).slice(
      0,
      12,
    )) {
      const w = value as Workspace;
      if (
        !w ||
        w.root !== root ||
        !Array.isArray(w.tabs) ||
        !Array.isArray(w.expanded)
      )
        continue;
      projects[root] = {
        root,
        view: ['Chat', 'Files', 'Changes', 'Runs', 'Settings'].includes(w.view)
          ? w.view
          : 'Chat',
        threadId: typeof w.threadId === 'string' ? w.threadId : null,
        tabs: w.tabs
          .filter((t) => t && typeof t.path === 'string')
          .slice(0, 40)
          .map((t) => ({
            path: t.path,
            mode: ['edit', 'preview', 'split'].includes(t.mode)
              ? t.mode
              : 'edit',
            cursor: Number.isFinite(t.cursor) ? Math.max(0, t.cursor) : 0,
            scroll: Number.isFinite(t.scroll) ? Math.max(0, t.scroll) : 0,
          })),
        activeFile: typeof w.activeFile === 'string' ? w.activeFile : '',
        expanded: w.expanded.filter((p) => typeof p === 'string').slice(0, 200),
        leftOpen: w.leftOpen !== false,
        rightOpen: w.rightOpen !== false,
        showHidden: w.showHidden === true,
        focusMode: w.focusMode === true,
      };
    }
    return {
      lastProject: typeof data.lastProject === 'string' ? data.lastProject : '',
      projects,
    };
  } catch {
    return { lastProject: '', projects: {} };
  }
}
export function saveWorkspace(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  workspace: Workspace,
) {
  const previous = readWorkspaces(storage);
  const projects = {
    [workspace.root]: workspace,
    ...Object.fromEntries(
      Object.entries(previous.projects)
        .filter(([root]) => root !== workspace.root)
        .slice(0, 11),
    ),
  };
  storage.setItem(
    KEY,
    JSON.stringify({ lastProject: workspace.root, projects }),
  );
}
