import { describe, expect, it } from 'vitest';
import {
  buildTrail,
  historyEvents,
  trailEvent,
  trailPath,
  trailStatus,
} from '../../src/lib/trail';
import { itemKey } from '../../src/lib/timeline';
import type { TimelineItem } from '../../src/lib/types';

const item = (patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'a',
  threadId: 'codex:t',
  turnId: 'r',
  kind: 'command',
  title: 'Command',
  command: 'cat src/auth.ts',
  status: 'completed',
  exitCode: 0,
  ...patch,
});
const read = (id: string, path: string, extra: Partial<TimelineItem> = {}) =>
  item({ id, commandActions: [{ type: 'read', path }], ...extra });

describe('an evidence-backed trail', () => {
  it('opens literal tool paths without interpreting URL escapes, fragments, or line suffixes', () => {
    expect(trailPath('/project/src/100% ready#1.ts', '/project')).toBe(
      'src/100% ready#1.ts',
    );
    expect(trailPath('src/a%20b.ts')).toBe('src/a%20b.ts');
    expect(trailPath('src/report:12')).toBe('src/report:12');
    expect(trailPath('./src/../README.md')).toBe('README.md');
    for (const path of [
      '../secret',
      '/project-other/file',
      '/etc/passwd',
      'https://example.test/file',
      'src/../../secret',
      'x'.repeat(1000),
    ])
      expect(trailPath(path, '/project')).toBeNull();
  });
  it('uses structured reads and searches, keeping unclassified commands literal', () => {
    expect(trailEvent(read('a', '/project/src/auth.ts'))).toMatchObject({
      kind: 'read',
      label: 'Read auth.ts',
      paths: ['/project/src/auth.ts'],
    });
    expect(
      trailEvent(item({ command: 'echo "read auth.ts then change it"' })),
    ).toMatchObject({ kind: 'command', label: 'Run a command' });
    expect(
      trailEvent(
        item({
          commandActions: [
            { type: 'search', query: 'refreshToken', path: 'src' },
          ],
        }),
      ),
    ).toMatchObject({ kind: 'search', query: 'refreshToken' });
  });
  it('supports Claude tools without assuming Codex is installed', () => {
    expect(
      trailEvent(
        item({
          kind: 'tool',
          title: 'Read',
          command: undefined,
          threadId: 'claude:t',
          toolInput: { path: '/project/auth.ts' },
          parentToolId: 'delegate',
        }),
      ),
    ).toMatchObject({
      kind: 'read',
      paths: ['/project/auth.ts'],
      parentToolId: 'delegate',
    });
    expect(
      trailEvent(
        item({ kind: 'tool', title: 'Grep', toolInput: { query: 'session' } }),
      ),
    ).toMatchObject({ kind: 'search', query: 'session' });
  });
  it('keeps causal statements as agent commentary and excludes private reasoning and optimistic messages', () => {
    const text = 'The old README caused the wrong implementation.';
    expect(
      trailEvent(item({ kind: 'message', command: undefined, text })),
    ).toMatchObject({ kind: 'note', label: 'Agent update', text });
    expect(trailEvent(item({ kind: 'thinking', text: 'private' }))).toBeNull();
    expect(trailEvent(item({ id: 'pending-123', kind: 'user' }))).toBeNull();
    expect(trailEvent(item({ kind: 'user', delivery: 'accepted' }))).toBeNull();
  });
  it('only calls checks passed when their exit status establishes it', () => {
    expect(trailEvent(item({ command: 'echo "npm test"' }))).toMatchObject({
      kind: 'command',
    });
    expect(
      trailEvent(item({ command: 'npm run build && echo "npm test"' })),
    ).toMatchObject({ kind: 'command' });
    expect(
      trailEvent(item({ command: 'npm test', exitCode: undefined })),
    ).toMatchObject({ label: 'Check finished' });
    expect(
      trailEvent(item({ command: 'npm test', exitCode: 1 })),
    ).toMatchObject({ label: 'Check failed', status: 'failed' });
    expect(
      trailEvent(item({ command: 'npm test', exitCode: 0 })),
    ).toMatchObject({ label: 'Check passed' });
    for (const command of [
      'npm test || true',
      'npm test; echo done',
      'npm test | tee results.txt',
      'npm test && echo done',
      'npm test &',
      'npm test\necho done',
      'npm exec -- echo "npm test"',
      'cargo run -- "cargo test"',
    ])
      expect(trailEvent(item({ command, exitCode: 0 }))).toMatchObject({
        kind: 'command',
        label: 'Run a command',
      });
    expect(
      trailEvent(item({ command: 'npm test', status: 'failed', exitCode: 0 })),
    ).toMatchObject({ label: 'Check failed', status: 'failed' });
    expect(
      trailEvent(
        item({ command: 'npm test', status: 'interrupted', exitCode: 0 }),
      ),
    ).toMatchObject({ label: 'Check finished', status: 'unknown' });
    expect(
      trailStatus(item({ status: 'inProgress', exitCode: undefined })),
    ).toBe('unknown');
    expect(
      trailStatus(item({ status: 'inProgress', exitCode: undefined }), 'r'),
    ).toBe('running');
  });
  it('groups adjacent successful reads, but preserves failures, parent boundaries, and retries', () => {
    const events = [
      read('1', 'a.ts'),
      read('2', 'b.ts'),
      read('3', 'c.ts', { exitCode: 1 }),
      read('4', 'c.ts'),
      read('5', 'd.ts', { parentToolId: 'child' }),
      item({ id: '6', command: 'npm test', exitCode: 1 }),
      item({ id: '7', command: 'npm test', exitCode: 0 }),
    ].map((i) => trailEvent(i)!);
    const result = buildTrail(events);
    expect(result.map((m) => m.label)).toEqual([
      'Read 2 files',
      'Read c.ts',
      'Read c.ts',
      'Read d.ts',
      'Check failed',
      'Check passed',
    ]);
    expect(result[0].key).toBe(events[0].key);
    expect(result[0].events.map((e) => e.id)).toEqual(['1', '2']);
  });
  it('does not merge different turns, threads, web searches, or unknown outcomes', () => {
    const events = [
      read('1', 'a'),
      read('2', 'b', { turnId: 'other' }),
      read('3', 'c', { turnId: 'other', threadId: 'other' }),
      read('4', 'd', { status: 'unknown' }),
      item({ id: '5', commandActions: [{ type: 'search', query: 'auth' }] }),
      item({ id: '6', kind: 'tool', title: 'Web search' }),
    ].map((i) => trailEvent(i)!);
    expect(buildTrail(events)).toHaveLength(6);
  });
  it('keeps compact excerpts and caps grouped exploration while retaining source identities', () => {
    expect(trailEvent(item({ command: 'x'.repeat(5000) }))).toMatchObject({
      text: 'x'.repeat(360),
      shortened: true,
    });
    const events = Array.from({ length: 30 }, (_, i) =>
      trailEvent(read(String(i), 'file' + i))!,
    );
    expect(buildTrail(events).map((m) => m.events.length)).toEqual([12, 12, 6]);
  });
  it('accepts newer history over stale live snapshots, but live events arriving during a read win', () => {
    const stale = item({ status: 'inProgress', exitCode: undefined });
    const completed = item({ status: 'completed', exitCode: 0 });
    const failed = item({ status: 'failed', exitCode: 1 });
    const before = new Map([[itemKey(stale), stale]]);
    expect(historyEvents([completed], before, [stale], 'r')[0].status).toBe(
      'completed',
    );
    expect(historyEvents([completed], before, [failed], 'r')[0].status).toBe(
      'failed',
    );
  });
});
