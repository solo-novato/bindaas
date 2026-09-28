<script lang="ts">
  import { motionEnabled } from '../motion';
  import { tick } from 'svelte';
  import { diffLines, diffHunks } from '../diff';
  import type { Context } from '../types';
  let {
    text,
    path,
    onopen,
    oncontext,
    onfollowup,
  }: {
    text: string;
    path: string;
    onopen: (path: string) => void;
    oncontext: (context: Context) => void;
    onfollowup?: (context: Context, prompt: string) => void;
  } = $props();
  let split = $state(false);
  let page = $state(0);
  let hunkIndex = $state(0);
  let scope = $state('hunk');
  let feedback = $state('');
  let body: HTMLDivElement;
  const hunks = $derived(diffHunks(text));
  const contentStart = $derived(hunks[0]?.row ?? 0);
  const lines = $derived(diffLines(text).slice(contentStart));
  const metadata = $derived(hunks.length ? text.slice(0, hunks[0].start) : '');
  const hunk = $derived(hunks[hunkIndex]);
  const size = 160;
  $effect(() => {
    path;
    page = 0;
    hunkIndex = 0;
    feedback = '';
    if (body) body.scrollTop = 0;
  });
  // Live edits can remove hunks/pages. Keep the selected file stable.
  $effect(() => {
    if (hunkIndex >= hunks.length) hunkIndex = Math.max(0, hunks.length - 1);
    if (page * size >= lines.length)
      page = Math.max(0, Math.ceil(lines.length / size) - 1);
  });
  async function jump(index: number) {
    hunkIndex = index;
    page = Math.floor((hunks[index].row - contentStart) / size);
    await tick();
    const target = body?.querySelector<HTMLElement>(
      `[data-row="${hunks[index].row}"]`,
    );
    if (target && body)
      body.scrollTop +=
        target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    // Briefly light up the lines of the change you jumped to.
    if (target && motionEnabled()) {
      const end = hunks[index + 1]?.row ?? Infinity;
      for (const row of body!.querySelectorAll<HTMLElement>('[data-row]')) {
        const n = Number(row.dataset.row);
        if (n >= hunks[index].row && n < end)
          row.animate(
            [
              {
                boxShadow: 'inset 3px 0 var(--accent)',
                filter: 'brightness(1.6)',
              },
              { boxShadow: 'inset 3px 0 transparent', filter: 'none' },
            ],
            { duration: 900, easing: 'ease-out' },
          );
      }
    }
  }
  function context(): Context {
    const selection = window.getSelection();
    const selected =
      selection &&
      !selection.isCollapsed &&
      body?.contains(selection.anchorNode) &&
      body?.contains(selection.focusNode)
        ? selection.toString()
        : '';
    const useHunk = !selected && scope === 'hunk' && hunk;
    const label = selected
      ? 'selected diff'
      : useHunk
        ? `change ${hunkIndex + 1}`
        : 'diff';
    const patch =
      selected || (useHunk ? text.slice(hunk.start, hunk.end) : text);
    return {
      id: crypto.randomUUID(),
      label: `${path} · ${label}`,
      text: `Diff for ${path}${useHunk ? `\n${hunk.header}` : ''}\n\n${patch.slice(0, 20000)}${patch.length > 20000 ? '\n[Context truncated to 20,000 characters]' : ''}`,
    };
  }
  function prepare(intent?: 'explain' | 'regressions') {
    const value = context();
    if (intent && onfollowup) {
      onfollowup(
        value,
        intent === 'explain'
          ? `Explain the attached change in ${path} and why it is needed.`
          : `Check the attached change in ${path} for regressions and missing edge cases. Report concrete findings before making edits.`,
      );
    } else oncontext(value);
    feedback = 'Added to your draft';
  }
</script>

<div class="diff-toolbar">
  <strong class="truncate" title={path}>{path || 'Diff'}</strong>
  <div class="segmented">
    <button
      class:chosen={!split}
      aria-pressed={!split}
      onclick={() => (split = false)}>Unified</button
    >
    <button
      class:chosen={split}
      aria-pressed={split}
      onclick={() => (split = true)}>Split</button
    >
  </div>
  {#if metadata}<details class="diff-metadata">
      <summary>Details</summary>
      <pre>{metadata}</pre>
    </details>{/if}
  <button onclick={() => onopen(path)}>File ↗</button>
</div>
{#if hunks.length}<div class="hunk-navigation">
    <button
      aria-label="Previous change"
      disabled={hunkIndex === 0}
      onclick={() => jump(hunkIndex - 1)}>↑</button
    >
    <select
      aria-label="Change in file"
      value={hunkIndex}
      onchange={(e) => jump(Number(e.currentTarget.value))}
    >
      {#each hunks as entry, index}<option value={index}
          >Change {index + 1} of {hunks.length} · {entry.nextCount
            ? `line ${entry.nextStart}`
            : `removed at line ${entry.oldStart}`}</option
        >{/each}
    </select>
    <button
      aria-label="Next change"
      disabled={hunkIndex === hunks.length - 1}
      onclick={() => jump(hunkIndex + 1)}>↓</button
    >
  </div>{/if}
<div class="diff-body" class:split-diff={split} bind:this={body}>
  {#each lines.slice(page * size, (page + 1) * size) as line, i (page * size + i)}
    <div
      class={`diff-line ${line.kind}`}
      data-row={contentStart + page * size + i}
    >
      {#if split}<span class="line-number">{line.old ?? ''}</span><code
          class="old-line">{line.kind === 'add' ? '' : line.text || ' '}</code
        ><span class="line-number">{line.next ?? ''}</span><code
          >{line.kind === 'delete' ? '' : line.text || ' '}</code
        >
      {:else}<span class="line-number">{line.old ?? ''}</span><span
          class="line-number">{line.next ?? ''}</span
        ><code
          ><span class="sign"
            >{line.kind === 'add'
              ? '+'
              : line.kind === 'delete'
                ? '−'
                : ' '}</span
          >{line.text || ' '}</code
        >{/if}
    </div>
  {/each}
</div>
{#if lines.length > size}<div class="pagination">
    <button
      disabled={page === 0}
      onclick={() => {
        page--;
        body.scrollTop = 0;
      }}>Previous</button
    ><span
      >Lines {page * size + 1}–{Math.min((page + 1) * size, lines.length)} of {lines.length}</span
    ><button
      disabled={(page + 1) * size >= lines.length}
      onclick={() => {
        page++;
        body.scrollTop = 0;
      }}>Next</button
    >
  </div>{/if}
<div class="diff-followup">
  {#if hunks.length}<select aria-label="Follow-up context" bind:value={scope}
      ><option value="hunk">This change</option><option value="file"
        >Whole file diff</option
      ></select
    >{/if}
  {#if onfollowup}<button onclick={() => prepare('explain')}>Explain</button
    ><button onclick={() => prepare('regressions')}>Check regressions</button
    >{:else}<button onclick={() => prepare()}>Ask Codex</button>{/if}
  <span class="muted" role="status">{feedback}</span>
</div>
