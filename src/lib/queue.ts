import type { Draft, Turn } from './types';

export const MAX_QUEUED_MESSAGES = 20;
export type QueueEntry = { id: string; draft: Draft };
export type TaskQueue = {
  entries: QueueEntry[];
  paused: boolean;
  error: string;
  sendingId: string | null;
  editing: { id: string; prompt: string } | null;
  // Consume each completion at most once, including duplicate bridge events.
  lastConsumedTurnId: string | null;
};

export function emptyQueue(): TaskQueue {
  return {
    entries: [],
    paused: false,
    error: '',
    sendingId: null,
    editing: null,
    lastConsumedTurnId: null,
  };
}

export function appendQueue(queue: TaskQueue, entry: QueueEntry): TaskQueue {
  if (queue.entries.length >= MAX_QUEUED_MESSAGES)
    throw new Error(
      `Queue up to ${MAX_QUEUED_MESSAGES} messages per conversation.`,
    );
  return {
    ...queue,
    ...(queue.entries.length ? {} : { paused: false, error: '' }),
    entries: [...queue.entries, entry],
  };
}

export function moveQueue(
  queue: TaskQueue,
  id: string,
  direction: -1 | 1,
): TaskQueue {
  if (queue.sendingId) return queue;
  const index = queue.entries.findIndex((entry) => entry.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= queue.entries.length) return queue;
  const entries = [...queue.entries];
  [entries[index], entries[next]] = [entries[next], entries[index]];
  return { ...queue, entries };
}

export function editQueue(
  queue: TaskQueue,
  id: string,
  prompt: string,
): TaskQueue {
  if (queue.sendingId) return queue;
  return {
    ...queue,
    editing: null,
    entries: queue.entries.map((entry) =>
      entry.id === id &&
      (prompt.trim() ||
        entry.draft.attachments.length ||
        entry.draft.contexts.length)
        ? { ...entry, draft: { ...entry.draft, prompt } }
        : entry,
    ),
  };
}

export function removeQueue(queue: TaskQueue, id: string): TaskQueue {
  if (queue.sendingId) return queue;
  const entries = queue.entries.filter((entry) => entry.id !== id);
  return { ...queue, entries, error: entries.length ? queue.error : '' };
}

export function canAdvanceQueue(queue: TaskQueue, turn?: Turn | null): boolean {
  return !!(
    queue.entries.length &&
    !queue.paused &&
    !queue.error &&
    !queue.sendingId &&
    !queue.editing &&
    turn?.status === 'completed' &&
    turn.id !== queue.lastConsumedTurnId
  );
}

export function pauseQueueAfterTurn(queue: TaskQueue, turn: Turn): TaskQueue {
  if (
    !queue.entries.length ||
    turn.status === 'inProgress' ||
    turn.status === 'completed'
  )
    return queue;
  const reason =
    turn.status === 'interrupted'
      ? 'The task was stopped.'
      : turn.status === 'connectionLost'
        ? 'The agent disconnected.'
        : 'The task failed.';
  return {
    ...queue,
    paused: true,
    error: `${reason} Review it, then resume the queue when ready.`,
  };
}

export function beginQueueSend(
  queue: TaskQueue,
  turnId: string | null,
): TaskQueue {
  if (queue.sendingId || queue.editing || !queue.entries.length) return queue;
  return {
    ...queue,
    sendingId: queue.entries[0].id,
    error: '',
    lastConsumedTurnId: turnId,
  };
}

export function finishQueueSend(
  queue: TaskQueue,
  id: string,
  error?: unknown,
): TaskQueue {
  if (queue.sendingId !== id) return queue;
  if (error !== undefined)
    return {
      ...queue,
      sendingId: null,
      paused: true,
      error: `Message remains queued. ${String(error)}`,
    };
  return {
    ...queue,
    sendingId: null,
    entries: queue.entries.filter((entry) => entry.id !== id),
  };
}

/** Keep an unfinished inline edit with its conversation when views change. */
export function beginQueueEdit(queue: TaskQueue, id: string): TaskQueue {
  if (queue.sendingId || queue.editing) return queue;
  const entry = queue.entries.find((entry) => entry.id === id);
  return entry
    ? { ...queue, paused: true, editing: { id, prompt: entry.draft.prompt } }
    : queue;
}

export function updateQueueEdit(queue: TaskQueue, prompt: string): TaskQueue {
  return queue.editing
    ? { ...queue, editing: { ...queue.editing, prompt } }
    : queue;
}

export function cancelQueueEdit(queue: TaskQueue): TaskQueue {
  return { ...queue, editing: null };
}
