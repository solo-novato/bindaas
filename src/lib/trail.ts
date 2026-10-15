import { itemKey } from './timeline';
import type { TimelineItem } from './types';

export type TrailKind =
  | 'request'
  | 'note'
  | 'plan'
  | 'search'
  | 'read'
  | 'edit'
  | 'check'
  | 'command'
  | 'tool'
  | 'status';
export type TrailStatus = 'running' | 'failed' | 'completed' | 'unknown';
/** A bounded navigation record. Full evidence remains in the native transcript. */
export type TrailEvent = {
  key: string;
  id: string;
  threadId: string;
  turnId: string;
  kind: TrailKind;
  label: string;
  text: string;
  paths: string[];
  query: string;
  status: TrailStatus;
  parentToolId: string | null;
  durationMs: number | null;
  exitCode: number | null;
  shortened: boolean;
};
export type TrailMoment = {
  key: string;
  kind: TrailKind;
  label: string;
  detail: string;
  status: TrailStatus;
  events: TrailEvent[];
};
export const TRAIL_LIMIT = 1600;
const excerpt = (value?: string | null, limit = 360) =>
  (value ?? '').trim().slice(0, limit);
const basename = (path: string) => path.split(/[\\/]/).at(-1) || path;
/** Structured tool paths are literal file names, not Markdown URLs. */
export function trailPath(path: string, projectRoot?: string): string | null {
  const root = projectRoot?.replace(/\/+$/, '');
  const relative =
    root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  if (/^[a-z][a-z\d+.-]*:|^\/|\\|\0/i.test(relative) || path.length >= 1000)
    return null;
  const parts: string[] = [];
  for (const part of relative.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
// A shell pipeline or compound command can hide a failed check's exit status.
// Only classify direct check invocations whose exit code describes that check.
function isCheck(command: string) {
  const direct = command.trim();
  return (
    !/[;&|\n`$]/.test(direct) &&
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint)(?=\s|$|:)|cargo\s+(?:test|check|clippy)(?=\s|$)|pytest(?=\s|$)|go\s+test(?=\s|$))/.test(
      direct,
    )
  );
}

export function trailStatus(
  item: TimelineItem,
  runningTurnId?: string | null,
): TrailStatus {
  if (item.status === 'inProgress')
    return item.turnId === runningTurnId ? 'running' : 'unknown';
  if (
    item.status === 'failed' ||
    item.status === 'declined' ||
    (item.exitCode != null && item.exitCode !== 0)
  )
    return 'failed';
  return item.status === 'completed' ? 'completed' : 'unknown';
}

export function trailEvent(
  item: TimelineItem,
  runningTurnId?: string | null,
): TrailEvent | null {
  // Private thoughts and inferred intent are not part of an activity trail.
  if (
    item.kind === 'thinking' ||
    item.delivery ||
    item.id.startsWith('pending-') ||
    item.id.startsWith('steer-')
  )
    return null;
  let kind: TrailKind = 'tool';
  let label = item.title || 'Tool call';
  let text = item.command || item.text || '';
  let paths = item.files?.map((file) => file.path).filter(Boolean) ?? [];
  let query = '';
  if (item.kind === 'user') {
    kind = 'request';
    label = 'Your direction';
  } else if (item.kind === 'message') {
    if (!item.text?.trim()) return null;
    kind = 'note';
    label = item.phase === 'final_answer' ? 'Agent response' : 'Agent update';
  } else if (item.kind === 'plan' || item.kind === 'planProgress') {
    kind = 'plan';
    label = item.kind === 'plan' ? 'Proposed plan' : 'Plan updated';
    text = item.text || item.steps?.map((s) => s.step).join(' · ') || '';
  } else if (item.kind === 'fileChange') {
    kind = 'edit';
  } else if (item.kind === 'command') {
    const actions = Array.isArray(item.commandActions)
      ? item.commandActions
      : [];
    if (isCheck(item.command ?? '')) {
      kind = 'check';
      label = 'Run checks';
    } else if (actions.length && actions.every((a) => a.type === 'read')) {
      kind = 'read';
      paths = actions.flatMap((a) => (a.path ? [a.path] : []));
    } else if (
      actions.length &&
      actions.every((a) => ['search', 'listFiles'].includes(a.type))
    ) {
      kind = 'search';
      query = actions
        .map((a) => a.query || a.path || '')
        .filter(Boolean)
        .join(' · ');
      label = actions.every((a) => a.type === 'listFiles')
        ? 'Explore files'
        : 'Search the project';
    } else {
      kind = 'command';
      label = 'Run a command';
    }
  } else if (item.kind === 'status') {
    kind = 'status';
  } else if (item.kind === 'tool') {
    if (item.title === 'Read') {
      kind = 'read';
      paths = item.toolInput?.path ? [item.toolInput.path] : [];
    } else if (
      ['Grep', 'Glob', 'WebSearch', 'Web search'].includes(item.title)
    ) {
      kind = 'search';
      label =
        item.title === 'Glob'
          ? 'Explore files'
          : item.title === 'Grep'
            ? 'Search the project'
            : 'Search the web';
      query = item.toolInput?.query ?? '';
    }
    text = item.toolInput?.description || text;
  }
  if (kind === 'read' || kind === 'edit') {
    const verb = kind === 'read' ? 'Read' : 'Edit';
    label =
      paths.length === 1
        ? `${verb} ${basename(paths[0])}`
        : paths.length
          ? `${verb} ${new Set(paths).size} files`
          : `${verb} files`;
  }
  if (kind === 'check' && item.status !== 'inProgress')
    label =
      trailStatus(item, runningTurnId) === 'failed'
        ? 'Check failed'
        : item.status === 'completed' && item.exitCode === 0
          ? 'Check passed'
          : 'Check finished';
  return {
    key: itemKey(item),
    id: item.id,
    threadId: item.threadId,
    turnId: item.turnId,
    kind,
    label: excerpt(label, 180),
    text: excerpt(text),
    query: excerpt(query, 180),
    paths: [...new Set(paths)].slice(0, 16).map((p) => p.slice(0, 1000)),
    status: trailStatus(item, runningTurnId),
    parentToolId: item.parentToolId ?? null,
    durationMs: item.durationMs ?? null,
    exitCode: item.exitCode ?? null,
    shortened:
      !!item.truncated || text.trim().length > 360 || paths.length > 16,
  };
}

export function buildTrail(events: TrailEvent[]): TrailMoment[] {
  const moments: TrailMoment[] = [];
  for (const event of events) {
    const last = moments.at(-1);
    // Only join adjacent, successful exploration. Failures and delegated lanes
    // remain separate; stable first-event keys survive streaming completions.
    if (
      last &&
      ['read', 'search'].includes(event.kind) &&
      last.kind === event.kind &&
      last.status === 'completed' &&
      event.status === 'completed' &&
      last.events.length < 12 &&
      last.events[0].turnId === event.turnId &&
      last.events[0].threadId === event.threadId &&
      last.events[0].parentToolId === event.parentToolId &&
      (event.kind !== 'search' || last.events[0].label === event.label)
    ) {
      last.events.push(event);
      const paths = [...new Set(last.events.flatMap((e) => e.paths))];
      last.label =
        event.kind === 'read' && paths.length
          ? `Read ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`
          : `${last.events.length} ${event.kind === 'read' ? 'file reads' : 'searches'}`;
      last.detail =
        event.kind === 'read'
          ? paths.map(basename).join(' · ')
          : last.events
              .map((e) => e.query || e.text)
              .filter(Boolean)
              .join(' · ');
    } else {
      moments.push({
        key: event.key,
        kind: event.kind,
        label: event.label,
        detail:
          event.query ||
          (event.kind === 'read' || event.kind === 'edit'
            ? event.paths.join(' · ')
            : event.text),
        status: event.status,
        events: [event],
      });
    }
  }
  return moments;
}

/** Reconcile a native history page with live updates received during its read. */
export function reconcileTrailHistory(
  page: TimelineItem[],
  before: Map<string, TimelineItem>,
  live: TimelineItem[],
) {
  const latest = new Map(live.map((item) => [itemKey(item), item]));
  return page.map((item) => {
    const key = itemKey(item),
      newer = latest.get(key);
    return newer && newer !== before.get(key) ? newer : item;
  });
}
export function historyEvents(
  page: TimelineItem[],
  before: Map<string, TimelineItem>,
  live: TimelineItem[],
  runningTurnId?: string | null,
) {
  return reconcileTrailHistory(page, before, live).flatMap((item) => {
    const event = trailEvent(item, runningTurnId);
    return event ? [event] : [];
  });
}
