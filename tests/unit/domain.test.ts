import { describe, it, expect } from 'vitest';
import { parseDiff, gitPath, diffLines, diffHunks } from '../../src/lib/diff';
import { markdown, linkTarget } from '../../src/lib/markdown';
import {
  applyDelta,
  mergeItem,
  checkKind,
  groupTimeline,
} from '../../src/lib/timeline';
import type { TimelineItem } from '../../src/lib/types';
import { editorText, diskText } from '../../src/lib/text';
it('round-trips CRLF without changing existing line endings', () => {
  const source = 'first\r\nsecond\r\n';
  const buffer = editorText(source);
  expect(buffer).toBe('first\nsecond\n');
  expect(diskText(buffer, 'crlf')).toBe(source);
  expect(diskText(buffer + 'third\n', 'crlf')).toBe(source + 'third\r\n');
});
describe('diff truth', () => {
  it('tracks files, renames and hunk lines', () => {
    const text =
      'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -3,2 +3,2 @@\n-before\n+after\n same\n';
    expect(parseDiff(text)[0]).toMatchObject({
      path: 'new.txt',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    });
    expect(diffLines(text).find((l) => l.kind === 'add')?.next).toBe(3);
  });
  it('decodes unicode and newline Git paths', () => {
    expect(gitPath('"a/hello\\nworld"')).toBe('a/hello\nworld');
    expect(gitPath('"a/\\303\\251.txt"')).toBe('a/é.txt');
  });
  it('handles file addition and deletion', () => {
    const add =
      'diff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+new\n';
    expect(parseDiff(add)[0].status).toBe('added');
  });
});
describe('Markdown security', () => {
  it('escapes HTML and rejects script links', () => {
    const html = markdown(
      '<script>alert(1)</script>\n[x](javascript:alert(1))\n![x](https://tracker.test/x)',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
  });
  it('keeps relative links within project', () => {
    expect(linkTarget('../README.md', 'docs/index.md')).toEqual({
      path: 'README.md',
    });
    expect(() => linkTarget('../../escape', 'docs/index.md')).toThrow();
    expect(() => linkTarget('file:///etc/passwd', 'README.md')).toThrow();
    expect(() => linkTarget('%2e%2e/escape', 'README.md')).toThrow();
    expect(
      linkTarget('/project/src/main.ts:12', '__chat__.md', '/project'),
    ).toEqual({ path: 'src/main.ts' });
    expect(() =>
      linkTarget('/project/../secret', '__chat__.md', '/project'),
    ).toThrow();
    expect(() =>
      linkTarget('/other/secret', '__chat__.md', '/project'),
    ).toThrow();
  });
});
describe('timeline truth and bounds', () => {
  const item: TimelineItem = {
    id: 'a',
    threadId: 't',
    turnId: 'r',
    kind: 'command',
    title: 'Command',
    status: 'inProgress',
    command: 'npm test',
  };
  it('completion replaces streaming output and ignores late deltas', () => {
    let items = applyDelta([item], {
      itemId: 'a',
      threadId: 't',
      turnId: 'r',
      kind: 'output',
      delta: 'x'.repeat(50000),
    });
    expect(items[0].output?.length).toBe(20480);
    expect(items[0].truncated).toBe(true);
    items = mergeItem(items, {
      ...item,
      status: 'completed',
      output: 'PASS',
      exitCode: 0,
    });
    items = applyDelta(items, {
      itemId: 'a',
      threadId: 't',
      turnId: 'r',
      kind: 'output',
      delta: 'late',
    });
    expect(items[0].output).toBe('PASS');
  });
  it('only classifies observed check commands', () => {
    expect(checkKind('npm run typecheck')).toBeTruthy();
    expect(checkKind('echo tests passed')).toBeNull();
    expect(checkKind('cargo test')).toBeTruthy();
  });
  it('does not merge equal item ids across turns', () => {
    expect(mergeItem([item], { ...item, turnId: 'other' })).toHaveLength(2);
  });
});

describe('workspace persistence', () => {
  it('recovers malformed storage and bounds restored metadata', async () => {
    const { readWorkspaces, saveWorkspace } =
      await import('../../src/lib/workspace');
    let value = 'broken JSON';
    const storage = {
      getItem: () => value,
      setItem: (_: string, data: string) => {
        value = data;
      },
    };
    expect(readWorkspaces(storage).lastProject).toBe('');
    saveWorkspace(storage, {
      root: '/project',
      view: 'Files',
      threadId: 'thread',
      tabs: [{ path: 'src/main.ts', mode: 'edit', cursor: 4, scroll: 100 }],
      activeFile: 'src/main.ts',
      expanded: ['src'],
      leftOpen: true,
      rightOpen: false,
      showHidden: false,
    });
    expect(readWorkspaces(storage).projects['/project']).toMatchObject({
      view: 'Files',
      threadId: 'thread',
      activeFile: 'src/main.ts',
      expanded: ['src'],
    });
    expect(value).not.toContain('content');
    const legacy = JSON.parse(value);
    legacy.projects['/project'].mode = 'plan';
    value = JSON.stringify(legacy);
    expect(readWorkspaces(storage).projects['/project']).not.toHaveProperty(
      'mode',
    );
  });
});

it('streams ordered thinking summary parts and treats completion as authoritative', () => {
  const delta = {
    itemId: 'thinking',
    threadId: 't',
    turnId: 'r',
    kind: 'thinking',
    delta: 'First',
    summaryIndex: 0,
  };
  let items = applyDelta([], delta);
  items = applyDelta(items, { ...delta, delta: 'Second', summaryIndex: 1 });
  items = applyDelta(items, { ...delta, delta: ' part', summaryIndex: 0 });
  expect(items[0]).toMatchObject({
    kind: 'thinking',
    text: 'First part\n\nSecond',
    status: 'inProgress',
  });
  items = mergeItem(items, {
    ...items[0],
    status: 'completed',
    text: 'Final summary',
  });
  expect(applyDelta(items, { ...delta, delta: 'late' })[0].text).toBe(
    'Final summary',
  );
});

it('compacts completed activity without hiding live work, failures, messages, or crossing turns', () => {
  const item = {
    threadId: 't',
    turnId: 'r',
    kind: 'command',
    title: 'Command',
    command: 'npm test',
    status: 'completed',
    exitCode: 0,
  };
  const items = [0, 1, 2].map((n) => ({ ...item, id: String(n) }));
  const rows = groupTimeline([
    ...items,
    { ...item, id: 'failed', exitCode: 1 },
    { ...item, id: 'live', status: 'inProgress', exitCode: undefined },
    { ...item, id: 'message', kind: 'message' },
  ]);
  expect(rows.map((r) => r.type)).toEqual(['group', 'item', 'item', 'item']);
  expect(rows[0]).toMatchObject({ label: '3 commands', items });
  expect(
    groupTimeline(items.map((i, n) => ({ ...i, turnId: String(n) }))).every(
      (r) => r.type === 'item',
    ),
  ).toBe(true);
});

it('hunk contexts retain exact patch boundaries, deletion ranges, and no-newline markers', () => {
  const text =
    'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -3,2 +3,0 @@\n-one\n-two\n@@ -20 +18 @@\n-before\n+after\n\\ No newline at end of file\n';
  const hunks = diffHunks(text);
  expect(hunks).toHaveLength(2);
  expect(hunks[0]).toMatchObject({
    oldStart: 3,
    oldCount: 2,
    nextStart: 3,
    nextCount: 0,
    row: 3,
  });
  expect(text.slice(hunks[0].start, hunks[0].end)).toBe(
    '@@ -3,2 +3,0 @@\n-one\n-two\n',
  );
  expect(text.slice(hunks[1].start, hunks[1].end)).toContain(
    '\\ No newline at end of file',
  );
  expect(diffLines(text).at(-1)?.next).toBeNull();
});

it('reading views retain bounded navigation metadata separately for each conversation', async () => {
  const { ReadingViews } = await import('../../src/lib/reading');
  const views = new ReadingViews();
  for (let i = 0; i < 25; i++)
    views.set(`thread-${i}`, {
      top: i,
      anchor: `item-${i}`,
      offset: 12,
      following: false,
      windowSize: 900,
      expanded: Array(800).fill('expanded'),
      expandedGroups: [],
    });
  expect(views.get('thread-0')).toBeUndefined();
  expect(views.get('thread-24')).toMatchObject({
    top: 24,
    anchor: 'item-24',
    windowSize: 400,
  });
  expect(views.get('thread-24')?.expanded).toHaveLength(400);
  expect(views.get('thread-23')?.anchor).toBe('item-23');
  views.clear();
  expect(views.get('thread-24')).toBeUndefined();
});

it('keeps plan deltas typed and replaces drafts with authoritative completion', () => {
  const delta = {
    itemId: 'p',
    turnId: 'turn',
    threadId: 'thread',
    kind: 'plan',
    delta: 'Draft proposal',
  };
  const streamed = applyDelta([], delta);
  expect(streamed[0]).toMatchObject({
    kind: 'plan',
    text: 'Draft proposal',
    status: 'inProgress',
  });
  const completed = mergeItem(streamed, {
    ...streamed[0],
    text: '# Final proposal',
    status: 'completed',
  });
  expect(applyDelta(completed, delta)[0].text).toBe('# Final proposal');
  expect(groupTimeline(completed)[0].type).toBe('item');
});

it('describes list recency compactly without inventing dates', async () => {
  const { relativeTime } = await import('../../src/lib/runs');
  const now = new Date(2026, 8, 28, 15, 0);
  const at = (d: Date) => d.getTime() / 1000;
  expect(relativeTime(undefined, now)).toBe('Date not recorded');
  expect(relativeTime(at(new Date(2026, 8, 28, 14, 59, 40)), now)).toBe(
    'Just now',
  );
  expect(relativeTime(at(new Date(2026, 8, 28, 14, 55)), now)).toBe('5m ago');
  expect(relativeTime(at(new Date(2026, 8, 27, 9, 0)), now)).toBe('Yesterday');
  expect(relativeTime(at(new Date(2026, 8, 10, 9, 0)), now)).toMatch(/Sep/);
  expect(relativeTime(at(new Date(2025, 0, 2, 9, 0)), now)).toMatch(/2025/);
});
