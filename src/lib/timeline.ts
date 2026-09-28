import type { TimelineItem } from './types';
export const TIMELINE_LIMIT = 400;
export function mergeItem(
  items: TimelineItem[],
  item: TimelineItem,
): TimelineItem[] {
  const index = items.findIndex(
    (i) => i.id === item.id && i.turnId === item.turnId,
  );
  if (index < 0) return [...items, item].slice(-TIMELINE_LIMIT);
  return items.map((v, i) => (i === index ? { ...v, ...item } : v));
}
export function applyDelta(
  items: TimelineItem[],
  delta: {
    itemId: string;
    turnId: string;
    threadId: string;
    kind: string;
    delta: string;
    truncated?: boolean;
    summaryIndex?: number;
  },
): TimelineItem[] {
  const existing = items.find(
    (i) => i.id === delta.itemId && i.turnId === delta.turnId,
  );
  if (existing && existing.status !== 'inProgress') return items;
  const item = existing ?? {
    id: delta.itemId,
    turnId: delta.turnId,
    threadId: delta.threadId,
    kind:
      delta.kind === 'output'
        ? 'command'
        : delta.kind === 'thinking'
          ? 'thinking'
          : delta.kind === 'plan'
            ? 'plan'
            : 'message',
    title:
      delta.kind === 'output'
        ? 'Command'
        : delta.kind === 'thinking'
          ? 'Thinking…'
          : delta.kind === 'plan'
            ? 'Proposed plan'
            : 'Codex',
    status: 'inProgress',
  };
  if (delta.kind === 'thinking') {
    const index = delta.summaryIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index > 1000) return items;
    const parts = { ...item.summaryParts };
    const prior = Object.values(parts).reduce((n, s) => n + s.length, 0);
    parts[index] =
      (parts[index] ?? '') +
      delta.delta.slice(0, Math.max(0, 128 * 1024 - prior));
    return mergeItem(items, {
      ...item,
      kind: 'thinking',
      title: 'Thinking…',
      summaryParts: parts,
      text: Object.keys(parts)
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => parts[i])
        .join('\n\n'),
      truncated:
        item.truncated ||
        delta.truncated ||
        prior + delta.delta.length > 128 * 1024,
    });
  }
  const key = delta.kind === 'output' ? 'output' : 'text';
  const text = (item[key] ?? '') + delta.delta;
  const cap = key === 'output' ? 20 * 1024 : 128 * 1024;
  return mergeItem(items, {
    ...item,
    [key]: key === 'output' ? text.slice(-cap) : text.slice(0, cap),
    truncated: item.truncated || delta.truncated || text.length > cap,
  });
}
export function checkKind(command: string): string | null {
  if (
    /(?:^|[\s/])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint)(?:\s|$|:)|\bcargo\s+(test|check|clippy)\b|\bpytest\b|\bgo test\b/.test(
      command,
    )
  )
    return command;
  return null;
}
export function duration(ms?: number | null) {
  if (ms == null) return '—';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export type TimelineRow =
  | { type: 'item'; key: string; item: TimelineItem }
  | { type: 'group'; key: string; items: TimelineItem[]; label: string };
export const itemKey = (item: TimelineItem) =>
  `${item.threadId}:${item.turnId}:${item.id}`;

export function groupTimeline(items: TimelineItem[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let pending: TimelineItem[] = [];
  function flush() {
    if (pending.length >= 3) {
      const commands = pending.filter((i) => i.kind === 'command').length;
      const files = new Set(
        pending.flatMap((i) => i.files?.map((f) => f.path) ?? []),
      );
      const facts = [
        commands ? `${commands} command${commands === 1 ? '' : 's'}` : '',
        files.size
          ? `${files.size} file${files.size === 1 ? '' : 's'} updated`
          : '',
      ].filter(Boolean);
      rows.push({
        type: 'group',
        key: `group:${itemKey(pending[0])}`,
        items: pending,
        label: facts.join(' · ') || `${pending.length} recorded actions`,
      });
    } else
      for (const item of pending)
        rows.push({ type: 'item', key: itemKey(item), item });
    pending = [];
  }
  for (const item of items) {
    const compact =
      ['command', 'fileChange', 'tool', 'status'].includes(item.kind) &&
      item.status === 'completed' &&
      (item.exitCode == null || item.exitCode === 0);
    if (
      pending.length &&
      (pending[0].turnId !== item.turnId ||
        pending[0].threadId !== item.threadId)
    )
      flush();
    if (compact) pending.push(item);
    else {
      flush();
      rows.push({ type: 'item', key: itemKey(item), item });
    }
  }
  flush();
  return rows;
}
