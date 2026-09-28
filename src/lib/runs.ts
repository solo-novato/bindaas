import type { RunStatus, Thread } from './types';

export function runtimeRunStatus(status: {
  type: string;
  activeFlags?: string[];
}): RunStatus {
  if (status.type === 'active') {
    if (status.activeFlags?.includes('waitingOnUserInput'))
      return 'waitingInput';
    if (status.activeFlags?.includes('waitingOnApproval'))
      return 'waitingApproval';
    return 'running';
  }
  if (status.type === 'systemError') return 'error';
  return status.type === 'idle' ? 'idle' : 'unknown';
}

export function completedRunStatus(status: string, hasPlan = false): RunStatus {
  if (status === 'completed') return hasPlan ? 'planGenerated' : 'completed';
  if (status === 'inProgress') return 'running';
  if (
    status === 'interrupted' ||
    status === 'failed' ||
    status === 'connectionLost'
  )
    return status;
  return 'unknown';
}

export function runBadge(thread: Thread) {
  const status =
    thread.runStatus ??
    runtimeRunStatus(thread.status ?? { type: 'notLoaded' });
  const labels: Record<RunStatus, string> = {
    running: 'Running',
    waitingInput: 'Waiting for input',
    waitingApproval: 'Waiting for approval',
    waiting: 'Waiting for response',
    planGenerated: 'Plan generated',
    completed: 'Completed',
    interrupted: 'Interrupted',
    failed: 'Failed',
    error: 'Error',
    connectionLost: 'Connection lost',
    idle: 'Idle',
    noTasks: 'No tasks yet',
    unknown: 'Status unavailable',
  };
  return {
    label: labels[status] ?? labels.unknown,
    tone: status.startsWith('waiting')
      ? 'attention'
      : status === 'running'
        ? 'active'
        : status === 'planGenerated'
          ? 'plan'
          : status === 'completed'
            ? 'success'
            : ['failed', 'error', 'connectionLost'].includes(status)
              ? 'error'
              : 'muted',
  };
}

export type HistoryFilter =
  'all' | 'attention' | 'running' | 'plans' | 'completed';
export function matchesRunFilter(thread: Thread, filter: HistoryFilter) {
  const tone = runBadge(thread).tone;
  return (
    filter === 'all' ||
    (filter === 'attention' && ['attention', 'error'].includes(tone)) ||
    (filter === 'running' && tone === 'active') ||
    (filter === 'plans' && tone === 'plan') ||
    (filter === 'completed' && tone === 'success')
  );
}

export function historyGroups(
  threads: Thread[],
  attentionFirst: boolean,
  now = new Date(),
) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  const buckets = new Map<string, Thread[]>([
    ['Needs attention', []],
    ['Today', []],
    ['Yesterday', []],
    ['Previous 7 days', []],
    ['Earlier', []],
  ]);
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const date = thread.updatedAt * 1000;
    const group =
      attentionFirst && matchesRunFilter(thread, 'attention')
        ? 'Needs attention'
        : date >= today.getTime()
          ? 'Today'
          : date >= yesterday.getTime()
            ? 'Yesterday'
            : date >= week.getTime()
              ? 'Previous 7 days'
              : 'Earlier';
    buckets.get(group)!.push(thread);
  }
  return [...buckets]
    .filter(([, rows]) => rows.length)
    .map(([label, threads]) => ({ label, threads }));
}

/** Short, scannable recency for lists: "Just now", "5m ago", "3:09 PM", "Yesterday", "Sep 17". */
export function relativeTime(seconds?: number, now = new Date()) {
  if (!seconds) return 'Date not recorded';
  const date = new Date(seconds * 1000);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date >= today)
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= yesterday) return 'Yesterday';
  const week = new Date(today);
  week.setDate(week.getDate() - 6);
  if (date >= week)
    return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
