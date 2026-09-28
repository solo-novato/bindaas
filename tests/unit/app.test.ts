import { describe, expect, it, vi } from 'vitest';
import {
  findMention,
  matchKnownFiles,
  ProjectSearch,
} from '../../src/lib/app/fileSearch.svelte';
import { buildLaunchEntries } from '../../src/lib/app/launchEntries';

describe('@ mentions', () => {
  it('finds the token at the caret only at a word boundary', () => {
    expect(findMention('Explain @src/ma', 15)).toEqual({
      start: 8,
      query: 'src/ma',
    });
    expect(findMention('@', 1)).toEqual({ start: 0, query: '' });
    expect(findMention('mail me@example.com', 19)).toBeNull();
    expect(findMention('done @a b', 9)).toBeNull();
  });

  it('matches known files case-insensitively without duplicates', () => {
    expect(
      matchKnownFiles(['src/Main.ts', 'README.md', 'src/Main.ts'], 'main'),
    ).toEqual([{ path: 'src/Main.ts', fileName: 'Main.ts', indices: null }]);
  });
});

describe('project search', () => {
  it('debounces, reports only the newest query, and signals unavailability', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (query: string) =>
      query === 'broken'
        ? Promise.reject(new Error('no codex'))
        : [{ path: `${query}.ts`, fileName: `${query}.ts`, indices: null }],
    );
    const results: unknown[] = [];
    const project = new ProjectSearch(search, () => true, 100);
    project.run('old', (files) => results.push(files));
    project.run('new', (files) => results.push(files));
    await vi.advanceTimersByTimeAsync(150);
    expect(search).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      [{ path: 'new.ts', fileName: 'new.ts', indices: null }],
    ]);
    project.run('broken', (files) => results.push(files));
    await vi.advanceTimersByTimeAsync(150);
    expect(results.at(-1)).toBeNull();
    project.run('   ', (files) => results.push(files));
    await vi.advanceTimersByTimeAsync(150);
    expect(search).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('launcher entries', () => {
  it('puts tasks needing attention first and adds typed project matches', () => {
    const noop = () => {};
    const entries = buildLaunchEntries(
      {
        navigationBusy: false,
        focusMode: false,
        changeCount: 0,
        projectOpen: true,
        canOpenProject: true,
        motion: 'expressive',
        settingsLoaded: true,
        multiAgent: false,
        taskRuns: {
          quiet: {
            title: 'Quiet task',
            waiting: false,
            turn: { id: 't1', status: 'completed' },
          },
          loud: {
            title: 'Needs me',
            waiting: true,
            turn: { id: 't2', status: 'inProgress' },
          },
        },
        threads: [],
        filePaths: ['README.md'],
        projectMatches: [
          { path: 'src/deep/util.ts', fileName: 'util.ts', indices: [0] },
          { path: 'README.md', fileName: 'README.md', indices: null },
        ],
      },
      {
        newTask: noop,
        compose: noop,
        toggleFocus: noop,
        navigate: noop,
        browseFiles: noop,
        showPanel: noop,
        chooseProject: noop,
        toggleMotion: noop,
        resume: noop,
        open: noop,
      },
    );
    expect(entries[0].title).toBe('Needs me');
    const files = entries.filter((e) => e.group === 'Files');
    expect(files.map((e) => e.detail)).toEqual([
      'README.md',
      'src/deep/util.ts',
    ]);
    expect(files[1].matched).toBe(true);
  });
});
