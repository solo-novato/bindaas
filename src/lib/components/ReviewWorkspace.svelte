<script lang="ts">
  import type { Snippet } from 'svelte';
  import DiffView from './DiffView.svelte';
  import { parseDiff } from '../diff';
  import type { Context, TimelineItem } from '../types';
  let {
    diff,
    files,
    selectedPath = $bindable(),
    reviewed = $bindable(),
    baseline,
    checks,
    active,
    truncated,
    source,
    controls,
    onopen,
    oncontext,
    onfollowup,
    onback,
  }: {
    diff: string;
    files: {
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }[];
    selectedPath: string;
    reviewed: Record<string, string>;
    baseline: string[];
    checks: TimelineItem[];
    active: boolean;
    truncated: boolean;
    source: string;
    controls: Snippet;
    onopen: (path: string) => void;
    oncontext: (context: Context) => void;
    onfollowup: (context: Context, prompt: string) => void;
    onback: () => void;
  } = $props();
  let query = $state('');
  let onlyRemaining = $state(false);
  const patches = $derived(
    new Map(parseDiff(diff).map((f) => [f.path, diff.slice(f.start, f.end)])),
  );
  const patch = $derived(patches.get(selectedPath) ?? '');
  const selected = $derived(files.find((f) => f.path === selectedPath));
  const totalReviewed = $derived(
    files.filter((f) => isReviewed(f.path)).length,
  );
  const visible = $derived(
    files.filter(
      (f) =>
        (!onlyRemaining || !isReviewed(f.path)) &&
        f.path.toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const position = $derived(visible.findIndex((f) => f.path === selectedPath));
  function isReviewed(path: string) {
    return (
      !truncated && !!patches.get(path) && reviewed[path] === patches.get(path)
    );
  }
  function mark() {
    if (!patch || truncated) return;
    if (isReviewed(selectedPath)) {
      const next = { ...reviewed };
      delete next[selectedPath];
      reviewed = next;
    } else {
      const candidates = visible;
      const after = candidates.findIndex((f) => f.path === selectedPath) + 1;
      // Keep only current patches; total retained text cannot exceed the bounded diff.
      reviewed = Object.fromEntries(
        files
          .filter((f) => isReviewed(f.path))
          .map((f) => [f.path, patches.get(f.path)!]),
      );
      reviewed = { ...reviewed, [selectedPath]: patch };
      const next = [
        ...candidates.slice(after),
        ...candidates.slice(0, after),
      ].find((f) => !isReviewed(f.path));
      if (next) selectedPath = next.path;
    }
  }
</script>

<section class="review-workspace" aria-label="Change review">
  <div class="review-overview">
    <div>
      <h1>
        {files.length
          ? `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`
          : 'Changes'}
      </h1>
      <p class="muted">{source}</p>
    </div>
    <button onclick={onback}>← Back to chat</button>
  </div>
  <div class="review-summary">
    <div class="review-progress">
      <span>{totalReviewed} of {files.length} reviewed</span><progress
        aria-label="Files reviewed"
        max={Math.max(1, files.length)}
        value={totalReviewed}
      ></progress>
    </div>
    <span class="add-count">+{files.reduce((n, f) => n + f.additions, 0)}</span
    ><span class="delete-count"
      >−{files.reduce((n, f) => n + f.deletions, 0)}</span
    >
    {#if active}<span class="muted">Live · review resets when edits change</span
      >{/if}
    <details class="review-checks">
      <summary
        >{checks.length
          ? `${checks.filter((c) => c.exitCode === 0).length}/${checks.length} observed checks passed`
          : 'No checks observed'}</summary
      >
      <div>
        {#each checks as check}<p>
            <span
              class:success={check.exitCode === 0}
              class:error={check.exitCode != null && check.exitCode !== 0}
              >{check.exitCode === 0
                ? '✓'
                : check.exitCode == null
                  ? '·'
                  : '×'}</span
            > <code>{check.command}</code><small
              >{check.exitCode == null
                ? 'No exit status'
                : `exit ${check.exitCode}`}</small
            >
          </p>{:else}<p>
            No test, lint, or typecheck commands were observed for this turn.
          </p>{/each}
      </div>
    </details>
  </div>
  {@render controls()}
  {#if files.length}<div class="review-layout">
      <aside class="review-files" aria-label="Review files">
        <input
          aria-label="Filter changed files"
          placeholder="Find a changed file…"
          bind:value={query}
        />
        <button
          class="review-filter"
          aria-pressed={onlyRemaining}
          onclick={() => (onlyRemaining = !onlyRemaining)}
          >{onlyRemaining ? 'Showing unreviewed' : 'Show unreviewed'}</button
        >
        <div class="review-file-list">
          {#each visible as file}<button
              class:selected={selectedPath === file.path}
              aria-current={selectedPath === file.path ? 'true' : undefined}
              onclick={() => (selectedPath = file.path)}
              title={file.path}
            >
              <span
                class:success={isReviewed(file.path)}
                class="review-file-icon"
                >{isReviewed(file.path)
                  ? '✓'
                  : file.status === 'deleted'
                    ? '−'
                    : file.status === 'added' || file.status === '??'
                      ? '+'
                      : '◇'}</span
              >
              <span class="review-file-name"
                ><strong>{file.path.split('/').at(-1)}</strong><small
                  >{file.path.includes('/')
                    ? file.path.slice(0, file.path.lastIndexOf('/'))
                    : 'Project root'}</small
                >{#if baseline.includes(file.path)}<small class="warning"
                    >Pre-existing edits</small
                  >{/if}</span
              >
              <span class="review-file-count"
                ><span class="add-count">+{file.additions}</span><span
                  class="delete-count">−{file.deletions}</span
                ></span
              >
            </button>{:else}<p class="muted padded">
              {query
                ? 'No files match your search.'
                : 'All files in this scope are reviewed.'}
            </p>{/each}
        </div>
      </aside>
      <div class="review-detail">
        <div class="review-file-navigation">
          <button
            aria-label="Previous file"
            disabled={position <= 0}
            onclick={() => (selectedPath = visible[position - 1].path)}
            >←</button
          >
          <span class="muted"
            >{position >= 0
              ? `File ${position + 1} of ${visible.length}`
              : 'Reviewed file'}</span
          >
          <button
            aria-label="Next file"
            disabled={position < 0 || position >= visible.length - 1}
            onclick={() => (selectedPath = visible[position + 1].path)}
            >→</button
          >
          <button
            class="mark-reviewed"
            class:success={isReviewed(selectedPath)}
            disabled={!patch || truncated}
            title={truncated
              ? 'The diff is incomplete'
              : !patch
                ? 'No patch is available to review'
                : 'Tracks this exact patch; later edits need another review'}
            onclick={mark}
            >{isReviewed(selectedPath)
              ? '✓ Reviewed · undo'
              : 'Mark reviewed & next'}</button
          >
        </div>
        {#if baseline.includes(selectedPath)}<p class="review-attribution">
            This file had edits before the task. Attribution may overlap.
          </p>{/if}
        {#if patch}<DiffView
            text={patch}
            path={selectedPath}
            {onopen}
            {oncontext}
            {onfollowup}
          />{:else}<div class="empty">
            <h2>{selected?.path.split('/').at(-1) ?? 'Select a file'}</h2>
            <p>
              {selected?.status === '??'
                ? 'This file is untracked. Git has no patch for it yet.'
                : 'No patch is available in this scope.'}
            </p>
            <button onclick={() => onopen(selectedPath)}>Open file ↗</button>
          </div>{/if}
      </div>
    </div>{:else}<div class="empty">
      <h2>No changes to review</h2>
      <p>File changes will appear here as Codex works.</p>
    </div>{/if}
</section>
