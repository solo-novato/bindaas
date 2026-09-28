import type { Harness, Connection } from './types';
export const agentName = (harness: Harness) =>
  harness === 'claude' ? 'Claude' : 'Codex';
export const harnessOf = (id?: string | null): Harness =>
  id?.startsWith('claude:') ? 'claude' : 'codex';
export const conversationKey = (id: string) =>
  id.startsWith('claude:') || id.startsWith('codex:') ? id : `codex:${id}`;
export const connectionKey = (
  value: Pick<Connection, 'harness' | 'threadId'>,
) => (value.harness === 'claude' ? (value.threadId ?? 'claude') : 'codex');
export function acceptsEvent(
  event: Connection,
  connections: Record<string, Connection>,
) {
  return (
    (event.generation ?? connections[connectionKey(event)]?.generation ?? 0) >=
    (connections[connectionKey(event)]?.generation ?? 0)
  );
}

/** Capabilities are declared per adapter, never inferred from a model name. */
export const harnessCapabilities = {
  codex: {
    steer: true,
    reasoningEffort: true,
    permissionProfiles: true,
    fastMode: true,
    taskDiff: true,
  },
  claude: {
    steer: false,
    reasoningEffort: false,
    permissionProfiles: false,
    fastMode: false,
    taskDiff: false,
  },
} as const;
