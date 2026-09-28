import { agentName, harnessOf } from '../harness';
import type { LaunchEntry } from '../launcher';
import { relativeTime, runBadge } from '../runs';
import type { FileMatch, Thread, Turn } from '../types';

// Everything the ⌘K launcher can jump to: live tasks first (attention on top),
// then actions, then files. Pure: App supplies state and the actions to run.

export type LaunchState = {
  navigationBusy: boolean;
  focusMode: boolean;
  changeCount: number;
  projectOpen: boolean;
  canOpenProject: boolean;
  motion: 'expressive' | 'saving';
  settingsLoaded: boolean;
  multiAgent: boolean;
  taskRuns: Record<
    string,
    { title: string; error?: string; waiting: boolean; turn: Turn }
  >;
  threads: Thread[];
  filePaths: string[];
  projectMatches: FileMatch[];
};

export type LaunchActions = {
  newTask: () => unknown;
  compose: () => unknown;
  toggleFocus: () => unknown;
  navigate: (view: string) => unknown;
  browseFiles: () => unknown;
  showPanel: (panel: 'permissions' | 'status') => unknown;
  chooseProject: () => unknown;
  toggleMotion: () => unknown;
  resume: (threadId: string) => unknown;
  open: (path: string) => unknown;
};

export function buildLaunchEntries(
  state: LaunchState,
  actions: LaunchActions,
): LaunchEntry[] {
  const saving = state.motion === 'saving';
  const commands: LaunchEntry[] = [
    {
      id: 'new',
      title: 'Start a new task',
      detail: 'A fresh conversation. Other tasks keep running.',
      group: 'Actions',
      icon: '+',
      shortcut: '⌘ N',
      disabled: state.navigationBusy,
      run: () => void actions.newTask(),
    },
    {
      id: 'compose',
      title: 'Write to Codex',
      detail: 'Return to your current draft',
      group: 'Actions',
      icon: '↗',
      shortcut: '⌘ ⇧ L',
      run: () => void actions.compose(),
    },
    {
      id: 'focus',
      title: state.focusMode ? 'Leave focus mode' : 'Enter focus mode',
      detail: state.focusMode
        ? 'Bring back your explorer and inspector'
        : 'Give the conversation the whole workspace',
      group: 'Actions',
      icon: '⊡',
      shortcut: '⌘ ⇧ F',
      run: () => void actions.toggleFocus(),
    },
    {
      id: 'review',
      title: 'Review changes',
      detail: `${state.changeCount} files in the current diff scope`,
      group: 'Actions',
      icon: '±',
      shortcut: '⌘ 3',
      disabled: !state.projectOpen,
      run: () => void actions.navigate('Changes'),
    },
    {
      id: 'history',
      title: 'Browse task history',
      detail: 'Find and continue an agent conversation',
      group: 'Actions',
      icon: '◷',
      shortcut: '⌘ 4',
      disabled: !state.projectOpen,
      run: () => void actions.navigate('Runs'),
    },
    {
      id: 'files',
      title: 'Browse project files',
      detail: 'Open your explorer and file workspace',
      group: 'Actions',
      icon: '▱',
      shortcut: '⌘ 2',
      disabled: !state.projectOpen,
      run: () => void actions.browseFiles(),
    },
    {
      id: 'permissions',
      title: 'Task permissions',
      detail: 'Review file, network, and approval access',
      group: 'Actions',
      icon: '◇',
      disabled: !state.projectOpen,
      run: () => void actions.showPanel('permissions'),
    },
    {
      id: 'status',
      title: 'Session status',
      detail: 'Model, mode, context usage, and account limits',
      group: 'Actions',
      icon: '◌',
      disabled: !state.projectOpen,
      run: () => void actions.showPanel('status'),
    },
    {
      id: 'project',
      title: 'Open a project',
      detail: 'Choose a folder on your Mac',
      group: 'Actions',
      icon: '▱',
      shortcut: '⌘ O',
      disabled: !state.canOpenProject,
      run: () => void actions.chooseProject(),
    },
    {
      id: 'motion',
      title: saving ? 'Turn on expressive motion' : 'Switch to power saving',
      detail: saving
        ? 'Bring back animations and effects'
        : 'Turn off animations, blur, and effects',
      group: 'Actions',
      icon: saving ? '✦' : '◐',
      shortcut: '⌘ ⇧ M',
      disabled: !state.settingsLoaded,
      run: () => void actions.toggleMotion(),
    },
    {
      id: 'settings',
      title: 'Bindaas settings',
      detail: 'Appearance, Codex executable, and idle behavior',
      group: 'Actions',
      icon: '⚙',
      run: () => void actions.navigate('Settings'),
    },
  ];
  const tasks = new Map<string, LaunchEntry>();
  for (const [id, task] of Object.entries(state.taskRuns))
    tasks.set(id, {
      id: `task:${id}`,
      title: task.title,
      detail: task.error
        ? 'Follow-up needs attention'
        : task.waiting
          ? 'Needs your input'
          : task.turn.status === 'inProgress'
            ? 'Working in this project'
            : task.turn.status === 'completed'
              ? 'Completed · continue conversation'
              : task.turn.status,
      group: 'Tasks',
      icon: task.waiting ? '!' : task.turn.status === 'inProgress' ? '◌' : '◷',
      attention:
        task.waiting ||
        !!task.error ||
        task.turn.status === 'failed' ||
        task.turn.status === 'connectionLost',
      disabled: state.navigationBusy,
      run: () => void actions.resume(id),
    });
  for (const thread of state.threads)
    if (!tasks.has(thread.id))
      tasks.set(thread.id, {
        id: `task:${thread.id}`,
        title: thread.name || thread.preview || 'Untitled task',
        detail: `${runBadge(thread).label} · ${relativeTime(thread.updatedAt)}`,
        attention: runBadge(thread).tone === 'attention',
        group: 'Tasks',
        icon: '◷',
        disabled: state.navigationBusy,
        run: () => void actions.resume(thread.id),
      });
  const paths = new Set(state.filePaths);
  const files: LaunchEntry[] = [...paths].map((path) => ({
    id: `file:${path}`,
    title: path.split('/').at(-1) ?? path,
    detail: path,
    keywords: path,
    group: 'Files',
    icon: '▤',
    run: () => void actions.open(path),
  }));
  // Typed queries add project-wide matches from Codex search.
  for (const match of state.projectMatches)
    if (!paths.has(match.path))
      files.push({
        id: `file:${match.path}`,
        title: match.fileName || match.path.split('/').at(-1) || match.path,
        detail: match.path,
        keywords: match.path,
        group: 'Files',
        icon: '▤',
        matched: true,
        run: () => void actions.open(match.path),
      });
  const orderedTasks = [...tasks.values()].sort(
    (a, b) => Number(!!b.attention) - Number(!!a.attention),
  );
  if (state.multiAgent)
    for (const task of orderedTasks)
      task.detail = `${agentName(harnessOf(task.id.slice(5)))} · ${task.detail}`;
  return [...orderedTasks, ...commands, ...files];
}
