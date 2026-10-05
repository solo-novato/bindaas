import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findMention,
  matchKnownFiles,
  ProjectSearch,
  LauncherSearch,
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
  afterEach(() => vi.useRealTimers());

  it('settles unavailable and empty searches without calling the backend', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => []);
    const result = vi.fn();
    const unavailable = new ProjectSearch(search, () => false);
    unavailable.run('hello', result);
    expect(result).toHaveBeenLastCalledWith(null);
    const project = new ProjectSearch(search, () => true);
    project.run('   ', result);
    expect(result).toHaveBeenLastCalledWith([]);
    await vi.runAllTimersAsync();
    expect(search).not.toHaveBeenCalled();
  });

  it('preserves an unavailable result from the backend', async () => {
    vi.useFakeTimers();
    const result = vi.fn();
    const project = new ProjectSearch(
      async () => null,
      () => true,
    );
    project.run('hello', result);
    await vi.runAllTimersAsync();
    expect(result).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('invalidates an in-flight request when search becomes unavailable', async () => {
    vi.useFakeTimers();
    let enabled = true;
    let resolve!: (files: []) => void;
    const search = vi.fn(
      () =>
        new Promise<[]>((done) => {
          resolve = done;
        }),
    );
    const result = vi.fn();
    const project = new ProjectSearch(search, () => enabled);
    project.run('hello', result);
    await vi.advanceTimersByTimeAsync(150);
    enabled = false;
    project.run('hello', result);
    expect(result).toHaveBeenCalledExactlyOnceWith(null);
    resolve([]);
    await vi.runAllTimersAsync();
    expect(result).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('clears old launcher matches while a newer query is pending', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (query: string) => [
      { path: `${query}.ts`, fileName: `${query}.ts`, indices: null },
    ]);
    const launcher = new LauncherSearch(new ProjectSearch(search, () => true));
    launcher.query('old', 'Files');
    await vi.runAllTimersAsync();
    expect(launcher.matches.map((file) => file.path)).toEqual(['old.ts']);
    launcher.query('new', 'Files');
    expect(launcher.matches).toEqual([]);
    expect(launcher.searching).toBe(true);
    await vi.runAllTimersAsync();
    expect(launcher.matches.map((file) => file.path)).toEqual(['new.ts']);
    expect(launcher.searching).toBe(false);
  });

  it('settles the launcher when no project is open', () => {
    const launcher = new LauncherSearch(
      new ProjectSearch(
        async () => [],
        () => false,
      ),
    );
    launcher.query('hello', 'Files');
    expect(launcher.matches).toEqual([]);
    expect(launcher.searching).toBe(false);
  });

  it('ignores out-of-order responses and failures after clearing or switching scope', async () => {
    vi.useFakeTimers();
    type Files = { path: string; fileName: string; indices: null }[];
    const requests = new Map<
      string,
      { resolve: (files: Files) => void; reject: (error: Error) => void }
    >();
    const project = new ProjectSearch(
      (query) =>
        new Promise<Files>((resolve, reject) => {
          requests.set(query, { resolve, reject });
        }),
      () => true,
    );
    const launcher = new LauncherSearch(project);
    launcher.query('old', 'Files');
    await vi.advanceTimersByTimeAsync(150);
    launcher.query('new', 'Files');
    await vi.advanceTimersByTimeAsync(150);
    const newest: Files = [
      { path: 'new.ts', fileName: 'new.ts', indices: null },
    ];
    requests.get('new')!.resolve(newest);
    await vi.advanceTimersByTimeAsync(0);
    requests
      .get('old')!
      .resolve([{ path: 'old.ts', fileName: 'old.ts', indices: null }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.matches).toEqual(newest);
    expect(launcher.searching).toBe(false);
    launcher.query('clear', 'Files');
    await vi.advanceTimersByTimeAsync(150);
    launcher.query('', 'Files');
    requests.get('clear')!.resolve(newest);
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.matches).toEqual([]);
    expect(launcher.searching).toBe(false);
    launcher.query('failed', 'All');
    await vi.advanceTimersByTimeAsync(150);
    launcher.query('failed', 'Actions');
    requests.get('failed')!.reject(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.matches).toEqual([]);
    expect(launcher.searching).toBe(false);
  });

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
        agentName: 'Codex',
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
        newWindow: noop,
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
