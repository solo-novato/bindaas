<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { rankEntries, type LaunchEntry, type LaunchScope } from '../launcher';
  import { motionEnabled, slidingIndicator, spotlight } from '../motion';
  let {
    entries,
    initialScope = 'All',
    projectName,
    loading = false,
    searching = false,
    onquery,
    onloadtasks,
    onclose,
    onselect,
  }: {
    entries: LaunchEntry[];
    initialScope?: LaunchScope;
    projectName: string;
    loading?: boolean;
    searching?: boolean;
    onquery?: (query: string, scope: LaunchScope) => void;
    onloadtasks: () => void;
    onclose: () => void;
    onselect: (entry: LaunchEntry) => void;
  } = $props();
  let query = $state('');
  let scope = $state<LaunchScope>(untrack(() => initialScope));
  let selected = $state(0);
  let input: HTMLInputElement;
  let results: HTMLDivElement;
  const matches = $derived(rankEntries(entries, query, scope));
  const current = $derived(matches[selected]);
  $effect(() => {
    query;
    scope;
    selected = 0;
    onquery?.(query, scope);
  });
  $effect(() => {
    if (selected >= matches.length) selected = Math.max(0, matches.length - 1);
  });
  function mount(node: HTMLDialogElement) {
    const before = document.activeElement as HTMLElement | null;
    node.showModal();
    input?.focus();
    return {
      destroy() {
        node.close();
        if (before?.isConnected) before.focus();
      },
    };
  }
  function move(direction: number) {
    if (!matches.length) return;
    selected = (selected + direction + matches.length) % matches.length;
    results
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
  function keys(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current && !current.disabled) onselect(current);
    }
  }
  async function changeScope(value: LaunchScope) {
    scope = value;
    if (value === 'Tasks') onloadtasks();
    await tick();
    input?.focus();
  }
</script>

<dialog
  class="command-menu"
  use:mount
  aria-label="Jump to anything"
  oncancel={(e) => {
    e.preventDefault();
    onclose();
  }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div class="command-content">
    <div class="command-caption">
      <span class="command-emblem">⌘K</span><span>{projectName}</span>
    </div>
    <div class="command-search">
      <span aria-hidden="true">⌕</span>
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={keys}
        role="combobox"
        aria-label="Search actions, tasks, and files"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls="command-results"
        aria-activedescendant={current
          ? `command-option-${selected}`
          : undefined}
        placeholder="Search tasks, files, and actions…"
        autocomplete="off"
        spellcheck="false"
      />
      <button
        class="command-escape"
        aria-label="Close launcher"
        onclick={onclose}>esc</button
      >
    </div>
    <div class="command-scopes" aria-label="Search categories">
      {#each ['All', 'Actions', 'Tasks', 'Files'] as value}<button
          aria-pressed={scope === value}
          onclick={() => changeScope(value as LaunchScope)}>{value}</button
        >{/each}
      {#if searching && query.trim()}<span
          class="command-searching"
          role="status">Searching project…</span
        >{/if}
      {#if scope === 'Tasks'}<button
          class="command-refresh"
          disabled={loading}
          onclick={onloadtasks}
          >{loading ? 'Loading…' : 'Refresh history'}</button
        >{/if}
    </div>
    <div
      class="command-results"
      id="command-results"
      bind:this={results}
      use:slidingIndicator={'[aria-selected="true"]'}
      use:spotlight
      role="listbox"
      aria-label="Destinations"
      aria-busy={scope === 'Tasks' && loading}
    >
      {#each matches as entry, index (entry.id)}<button
          id={`command-option-${index}`}
          data-index={index}
          class="command-option"
          data-spotlight
          animate:flip={{ duration: motionEnabled() ? 200 : 0 }}
          role="option"
          aria-selected={index === selected}
          aria-disabled={entry.disabled ?? false}
          tabindex="-1"
          onpointermove={() => (selected = index)}
          onclick={() => !entry.disabled && onselect(entry)}
        >
          <span class="command-icon" class:attention={entry.attention}
            >{entry.icon}</span
          >
          <span class="command-copy"
            ><strong>{entry.title}</strong><small>{entry.detail}</small></span
          >
          {#if entry.shortcut}<kbd>{entry.shortcut}</kbd>{:else}<span
              class="command-kind"
              >{entry.group === 'Actions'
                ? 'Action'
                : entry.group === 'Tasks'
                  ? 'Task'
                  : 'File'}</span
            >{/if}
          {#if index === selected}<span
              class="command-return"
              aria-hidden="true">↵</span
            >{/if}
        </button>{:else}<div class="command-empty">
          <strong
            >{loading && scope === 'Tasks'
              ? 'Finding your conversations…'
              : query
                ? 'No match yet'
                : scope === 'Tasks'
                  ? 'Your next idea starts here'
                  : 'Nothing here yet'}</strong
          >
          <p>
            {query
              ? 'Try a shorter name or switch categories.'
              : scope === 'Tasks'
                ? 'Start a task, or refresh to find past conversations.'
                : 'Open a project and explore a folder to make its files available here.'}
          </p>
        </div>{/each}
    </div>
    <footer class="command-footer">
      <span
        ><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close</span
      >{#if scope === 'Files'}<span>Open tabs and explored folders</span>{/if}
    </footer>
  </div>
</dialog>

<style>
  .command-menu {
    padding: 0;
    width: min(640px, calc(100vw - 48px));
    max-width: none;
    margin: min(14vh, 130px) auto auto;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-xl);
    color: var(--text);
    background: var(--glass-surface, var(--raised));
    backdrop-filter: var(--glass-blur, none);
    -webkit-backdrop-filter: var(--glass-blur, none);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    animation: arrive 360ms var(--ease-spring);
  }
  .command-menu[open]::backdrop {
    animation: backdrop-in 240ms ease-out;
  }
  @keyframes backdrop-in {
    from {
      opacity: 0;
    }
  }
  .command-menu::backdrop {
    background: #05060a8c;
    backdrop-filter: blur(3px);
  }
  .command-caption {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 14px 18px 4px;
    color: var(--muted);
    font-size: var(--fs-xs);
  }
  .command-emblem {
    color: var(--accent);
    font: 600 var(--fs-xs) var(--mono);
  }
  .command-search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 18px 10px;
  }
  .command-search > span {
    font-size: 22px;
    color: var(--muted);
  }
  .command-search input {
    min-width: 0;
    flex: 1;
    border: none;
    background: none;
    box-shadow: none;
    outline: none;
    padding: 6px 0;
    font-size: 18px;
    letter-spacing: -0.3px;
  }
  .command-escape,
  kbd {
    font-family: inherit;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 5px;
    font-size: var(--fs-xs);
    color: var(--muted);
    background: var(--surface);
  }
  .command-scopes {
    display: flex;
    gap: 4px;
    padding: 0 14px 10px;
    border-bottom: 1px solid var(--border);
  }
  .command-scopes button {
    font-size: var(--fs-xs);
    color: var(--muted);
    border-radius: var(--r-sm);
    padding: 4px 10px;
  }
  .command-scopes [aria-pressed='true'] {
    color: var(--text);
    background: var(--hover);
  }
  .command-searching {
    margin-left: auto;
    align-self: center;
    font-size: var(--fs-xs);
    color: var(--muted);
  }
  .command-scopes .command-refresh {
    margin-left: auto;
    padding-right: 0;
  }
  .command-results {
    position: relative;
    max-height: min(410px, 46vh);
    overflow: auto;
    padding: 6px;
    overscroll-behavior: contain;
    scroll-padding: 8px;
  }
  .command-option {
    width: 100%;
    display: flex;
    gap: 12px;
    align-items: center;
    text-align: left;
    border: 1px solid transparent;
    border-radius: var(--r-md);
    min-height: 46px;
    padding: 6px 10px;
  }
  .command-option {
    position: relative;
    z-index: 1;
  }
  /* One highlight glides between results instead of each row lighting up. */
  .command-results::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: var(--indicator-w, 0);
    height: var(--indicator-h, 0);
    opacity: var(--indicator-opacity, 0);
    transform: translate(var(--indicator-x, 0), var(--indicator-y, 0));
    border: 1px solid var(--accent-line);
    border-radius: var(--r-md);
    background: var(--accent-soft);
    transition:
      transform 220ms var(--ease-spring),
      height 180ms var(--ease-out),
      opacity 120ms ease;
    pointer-events: none;
  }
  .command-option[aria-selected='true'] .command-icon {
    color: var(--accent);
    border-color: var(--accent-line);
  }
  .command-option[aria-disabled='true'] {
    opacity: 0.5;
  }
  .command-icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    color: var(--muted);
    font-size: 14px;
    flex-shrink: 0;
  }
  .command-icon.attention {
    color: var(--amber);
    border-color: color-mix(in srgb, var(--amber) 40%, var(--border));
  }
  .command-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .command-copy strong {
    font-size: var(--fs-base);
    font-weight: 500;
  }
  .command-copy small {
    color: var(--muted);
    font-size: var(--fs-xs);
  }
  .command-copy strong,
  .command-copy small {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .command-kind {
    color: var(--muted);
    font-size: var(--fs-xs);
  }
  .command-return {
    width: 16px;
    color: var(--accent);
  }
  .command-empty {
    padding: 36px 20px;
    text-align: center;
  }
  .command-empty strong {
    font-size: 14px;
    font-weight: 500;
  }
  .command-empty p {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }
  .command-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    border-top: 1px solid var(--border);
    padding: 9px 16px;
    color: var(--muted);
    font-size: var(--fs-xs);
  }
  .command-footer span:first-child {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(-14px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .command-menu {
      animation: none;
    }
  }
</style>
