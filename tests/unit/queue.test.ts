import { describe, expect, it } from 'vitest';
import {
  appendQueue,
  beginQueueEdit,
  updateQueueEdit,
  cancelQueueEdit,
  beginQueueSend,
  canAdvanceQueue,
  editQueue,
  emptyQueue,
  finishQueueSend,
  MAX_QUEUED_MESSAGES,
  moveQueue,
  pauseQueueAfterTurn,
  removeQueue,
  type QueueEntry,
} from '../../src/lib/queue';
import type { Turn } from '../../src/lib/types';

function entry(id: string): QueueEntry {
  return {
    id,
    draft: {
      prompt: `Task ${id}`,
      harness: 'codex',
      permissions: { permissions: ':workspace', approvalPolicy: 'on-request' },
      contexts: [{ id: 'context', label: 'selected change', text: '+safe' }],
      attachments: [
        { id: 'attachment', name: 'design.png', kind: 'image', sizeBytes: 42 },
      ],
      mode: 'plan',
      overrides: true,
      model: 'from-agent',
      effort: 'high',
    },
  };
}
const completed = { id: 'turn-1', status: 'completed' } as Turn;
const populated = () =>
  ['a', 'b', 'c'].reduce(
    (queue, id) => appendQueue(queue, entry(id)),
    emptyQueue(),
  );
const order = (queue: ReturnType<typeof emptyQueue>) =>
  queue.entries.map((item) => item.id);

describe('conversation task queue', () => {
  it('has no shared mutable state between conversations', () => {
    const a = emptyQueue(),
      b = emptyQueue();
    a.entries.push(entry('a'));
    expect(b.entries).toEqual([]);
    expect(canAdvanceQueue(b, completed)).toBe(false);
  });

  it('appends in FIFO order without changing the original snapshot', () => {
    const original = populated();
    const next = appendQueue(original, entry('d'));
    expect(order(original)).toEqual(['a', 'b', 'c']);
    expect(order(next)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.entries[3].draft).toEqual(entry('d').draft);
  });

  it('bounds retained queue entries and rejects overflow without losing work', () => {
    let queue = emptyQueue();
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i++)
      queue = appendQueue(queue, entry(String(i)));
    expect(() => appendQueue(queue, entry('overflow'))).toThrow(
      'Queue up to 20 messages',
    );
    expect(queue.entries).toHaveLength(20);
  });

  it('only reorders an existing entry inside the list bounds', () => {
    const queue = populated();
    expect(order(moveQueue(queue, 'b', -1))).toEqual(['b', 'a', 'c']);
    expect(order(moveQueue(queue, 'b', 1))).toEqual(['a', 'c', 'b']);
    expect(moveQueue(queue, 'a', -1)).toBe(queue);
    expect(moveQueue(queue, 'c', 1)).toBe(queue);
    expect(moveQueue(queue, 'missing', 1)).toBe(queue);
    expect(order(queue)).toEqual(['a', 'b', 'c']);
  });

  it('edits only the prompt and preserves captured settings, context, and attachments', () => {
    const queue = populated();
    const next = editQueue(queue, 'b', 'Revised task');
    expect(next.entries[1].draft).toEqual({
      ...entry('b').draft,
      prompt: 'Revised task',
    });
    expect(queue.entries[1].draft.prompt).toBe('Task b');
    expect(next.entries[0]).toBe(queue.entries[0]);
  });

  it('allows attachment-only edits but refuses an entirely empty message', () => {
    expect(editQueue(populated(), 'a', '').entries[0].draft.prompt).toBe('');
    const queue = emptyQueue();
    const message = entry('a');
    message.draft.attachments = [];
    message.draft.contexts = [];
    const next = appendQueue(queue, message);
    expect(editQueue(next, 'a', ' ').entries[0]).toBe(message);
  });

  it('removes one entry and preserves the remaining order', () => {
    const queue = populated();
    expect(order(removeQueue(queue, 'b'))).toEqual(['a', 'c']);
    expect(order(queue)).toEqual(['a', 'b', 'c']);
    expect(order(removeQueue(queue, 'missing'))).toEqual(['a', 'b', 'c']);
  });

  it('advances only after a successful, unconsumed terminal turn', () => {
    const queue = populated();
    expect(canAdvanceQueue(queue, completed)).toBe(true);
    for (const status of [
      'inProgress',
      'failed',
      'interrupted',
      'connectionLost',
    ] as Turn['status'][])
      expect(canAdvanceQueue(queue, { ...completed, status })).toBe(false);
    expect(canAdvanceQueue(queue)).toBe(false);
    expect(canAdvanceQueue(queue, null)).toBe(false);
    expect(canAdvanceQueue({ ...queue, paused: true }, completed)).toBe(false);
    expect(canAdvanceQueue({ ...queue, error: 'Try again' }, completed)).toBe(
      false,
    );
  });

  it('locks one in-flight entry without removing its data before acknowledgement', () => {
    const queue = populated();
    const sending = beginQueueSend(queue, completed.id);
    expect(sending.sendingId).toBe('a');
    expect(order(sending)).toEqual(['a', 'b', 'c']);
    expect(beginQueueSend(sending, 'other-turn')).toBe(sending);
    expect(canAdvanceQueue(sending, completed)).toBe(false);
    expect(moveQueue(sending, 'b', -1)).toBe(sending);
    expect(editQueue(sending, 'a', 'lost')).toBe(sending);
    expect(removeQueue(sending, 'a')).toBe(sending);
  });

  it('dequeues exactly the acknowledged entry and ignores stale completion receipts', () => {
    const sending = beginQueueSend(populated(), completed.id);
    expect(finishQueueSend(sending, 'stale')).toBe(sending);
    const next = finishQueueSend(sending, 'a');
    expect(order(next)).toEqual(['b', 'c']);
    expect(next.sendingId).toBeNull();
    expect(canAdvanceQueue(next, completed)).toBe(false);
    expect(canAdvanceQueue(next, { ...completed, id: 'turn-2' })).toBe(true);
    expect(finishQueueSend(next, 'a')).toBe(next);
  });

  it('retains a failed send and all later entries, and requires an explicit retry', () => {
    const sending = beginQueueSend(populated(), completed.id);
    const failed = finishQueueSend(
      sending,
      'a',
      new Error('Agent unavailable'),
    );
    expect(order(failed)).toEqual(['a', 'b', 'c']);
    expect(failed.paused).toBe(true);
    expect(failed.error).toContain('Message remains queued');
    expect(failed.error).toContain('Agent unavailable');
    expect(failed.sendingId).toBeNull();
    expect(canAdvanceQueue(failed, { ...completed, id: 'later' })).toBe(false);
    const retry = beginQueueSend(failed, completed.id);
    expect(retry.sendingId).toBe('a');
    expect(retry.error).toBe('');
    expect(finishQueueSend(retry, 'a').paused).toBe(true);
  });

  it.each(['failed', 'interrupted', 'connectionLost'] as Turn['status'][])(
    'pauses queued work after %s without deleting it',
    (status) => {
      const result = pauseQueueAfterTurn(populated(), { ...completed, status });
      expect(result.paused).toBe(true);
      expect(result.error).toContain('resume the queue');
      expect(order(result)).toEqual(['a', 'b', 'c']);
    },
  );

  it('does not treat successful completion as permission to resume a paused queue', () => {
    const paused = { ...populated(), paused: true };
    expect(pauseQueueAfterTurn(paused, completed)).toBe(paused);
    expect(canAdvanceQueue(paused, completed)).toBe(false);
  });

  it('preserves a failure that arrives while send acknowledgement is in flight', () => {
    const sending = beginQueueSend(populated(), completed.id);
    const failed = pauseQueueAfterTurn(sending, {
      id: 'turn-2',
      status: 'failed',
    });
    const acknowledged = finishQueueSend(failed, 'a');
    expect(order(acknowledged)).toEqual(['b', 'c']);
    expect(acknowledged.paused).toBe(true);
    expect(acknowledged.error).toContain('task failed');
  });

  it('resets an emptied queue for a fresh workflow but never resumes an existing queue by appending', () => {
    const paused = { ...populated(), paused: true, error: 'Previous error' };
    expect(appendQueue(paused, entry('d')).paused).toBe(true);
    let cleared = paused;
    for (const id of ['a', 'b', 'c']) cleared = removeQueue(cleared, id);
    expect(cleared.error).toBe('');
    expect(appendQueue(cleared, entry('fresh')).paused).toBe(false);
  });
  it('keeps an unfinished edit separate from the sendable draft and pauses execution', () => {
    const original = populated();
    const editing = updateQueueEdit(
      beginQueueEdit(original, 'b'),
      'Unfinished revision',
    );
    expect(editing.editing).toEqual({ id: 'b', prompt: 'Unfinished revision' });
    expect(editing.entries[1].draft.prompt).toBe('Task b');
    expect(editing.paused).toBe(true);
    expect(canAdvanceQueue({ ...editing, paused: false }, completed)).toBe(
      false,
    );
    expect(beginQueueSend(editing, completed.id)).toBe(editing);
    const canceled = cancelQueueEdit(editing);
    expect(canceled.editing).toBeNull();
    expect(canceled.entries[1].draft.prompt).toBe('Task b');
    expect(canceled.paused).toBe(true);
    const saved = editQueue(editing, 'b', editing.editing!.prompt);
    expect(saved.editing).toBeNull();
    expect(saved.entries[1].draft.prompt).toBe('Unfinished revision');
    expect(saved.paused).toBe(true);
  });

  it('does not start a second edit or edit while an entry is sending', () => {
    const original = populated();
    expect(beginQueueEdit(original, 'missing')).toBe(original);
    const editing = beginQueueEdit(original, 'b');
    expect(beginQueueEdit(editing, 'c')).toBe(editing);
    const sending = beginQueueSend(original, completed.id);
    expect(beginQueueEdit(sending, 'b')).toBe(sending);
  });
});
