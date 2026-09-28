<script lang="ts">
  import { rise } from '../motion';
  import Tree from './Tree.svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import { api } from '../api';
  import type { Entry } from '../types';
  import type { TreeAction } from './TreeMenu.svelte';
  import { cancelEdit, explorer } from '../explorer.svelte';
  let {
    path = '',
    expanded = [],
    changed = [],
    ontoggle,
    depth = 0,
    showHidden = false,
    onopen,
    ondiscover,
    onmenu,
    onaction,
    oncommit,
  }: {
    path?: string;
    expanded?: string[];
    changed?: string[];
    ontoggle: (path: string) => void;
    depth?: number;
    showHidden?: boolean;
    onopen: (path: string) => void;
    ondiscover: (entries: Entry[]) => void;
    onmenu: (
      entry: Entry | null,
      x: number,
      y: number,
      trigger: HTMLElement,
    ) => void;
    onaction: (entry: Entry, action: TreeAction) => void;
    oncommit: (name: string) => void;
  } = $props();
  // Rows are reached by name (aria-label); the "⋯" affordance is pointer-only,
  // and keyboard users open the same menu with Shift+F10 or the menu key.
  function rowKeys(event: KeyboardEvent, entry: Entry) {
    const row = event.currentTarget as HTMLElement;
    if (
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey)
    ) {
      event.preventDefault();
      const box = row.getBoundingClientRect();
      onmenu(entry, box.left + 28, box.bottom, row);
    } else if (event.key === 'F2') {
      event.preventDefault();
      onaction(entry, 'rename');
    } else if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onaction(entry, 'trash');
    }
  }
  function focusName(node: HTMLInputElement) {
    node.focus();
    // Select the name without its extension, the part most renames change.
    const dot = node.value.lastIndexOf('.');
    node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
  }
  function fieldKeys(event: KeyboardEvent) {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (input.value.trim()) oncommit(input.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  }
  function fieldBlur(event: FocusEvent, initial: string) {
    const input = event.currentTarget as HTMLInputElement;
    if (explorer.busy) return;
    if (explorer.error || !input.value.trim() || input.value === initial)
      cancelEdit();
    else oncommit(input.value);
  }
  let entries = $state<Entry[]>([]);
  let loading = $state(false);
  let error = $state('');
  let truncated = $state(false);

  function fileIcon(name: string): IconName {
    if (/\.(md|markdown|mdx)$/i.test(name)) return 'markdown';
    if (
      /\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue|rs|py|go|java|c|h|cpp|hpp|css|scss|html|json|yaml|yml|toml|xml|sh)$/i.test(
        name,
      )
    )
      return 'code';
    return 'file';
  }
  $effect(() => {
    const hidden = showHidden;
    const relative = path;
    explorer.revisions[relative];
    let live = true;
    const timer = setTimeout(() => (loading = true), 120);
    api
      .list(relative, hidden)
      .then((data) => {
        if (live) {
          entries = data.entries;
          truncated = data.truncated;
          ondiscover(data.entries);
        }
      })
      .catch((e) => {
        if (live) error = String(e);
      })
      .finally(() => {
        clearTimeout(timer);
        if (live) loading = false;
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });
</script>

{#if loading}<p class="muted tree-note">Loading folder…</p>{/if}
{#if error}<p class="error tree-note">{error}</p>{/if}
{#if explorer.editing?.mode === 'create' && explorer.editing.parent === path}
  {@render nameField(
    explorer.editing.directory,
    '',
    explorer.editing.directory ? 'New folder name' : 'New file name',
  )}
{/if}
{#each entries as entry (entry.path)}
  {@const open = entry.directory && expanded.includes(entry.path)}
  {@const icon = entry.directory
    ? open
      ? 'folder-open'
      : 'folder'
    : fileIcon(entry.name)}
  {#if explorer.editing?.mode === 'rename' && explorer.editing.path === entry.path}
    {@render nameField(entry.directory, entry.name, `Rename ${entry.name}`)}
  {:else}
    <div
      class="tree-item"
      class:selected={explorer.selected === entry.path}
      oncontextmenu={(event) => {
        event.preventDefault();
        explorer.selected = entry.path;
        onmenu(
          entry,
          event.clientX,
          event.clientY,
          (event.currentTarget as HTMLElement).querySelector('button')!,
        );
      }}
      role="presentation"
    >
      <button
        class="tree-row"
        style:padding-left={`${14 + depth * 14}px`}
        title={entry.path}
        aria-label={entry.name}
        aria-keyshortcuts="Shift+F10 F2 Meta+Backspace"
        onclick={() => {
          explorer.selected = entry.path;
          if (entry.directory) {
            ontoggle(entry.path);
          } else onopen(entry.path);
        }}
        onkeydown={(event) => rowKeys(event, entry)}
        aria-expanded={entry.directory
          ? expanded.includes(entry.path)
          : undefined}
      >
        <span class="tree-chevron" aria-hidden="true">
          {#if entry.directory}<Icon
              name={open ? 'chevron-down' : 'chevron-right'}
              size={12}
            />{/if}
        </span>
        <span
          class="entry-icon"
          class:directory={entry.directory}
          class:source={icon === 'code'}
          class:document={icon === 'markdown'}
          ><Icon name={icon} size={15} /></span
        >
        <span class="entry-name" class:folder={entry.directory}
          >{entry.name}</span
        >
        {#if !entry.directory && changed.includes(entry.path)}<span
            class="changed-dot"
            title="Changed"
            aria-hidden="true"
          ></span>{/if}
        {#if entry.symlink}<span class="entry-symlink" aria-hidden="true"
            ><Icon name="arrow-right" size={11} /></span
          >{/if}
      </button>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Pointer shortcut; keyboard users press Shift+F10 on the row.) -->
      <span
        class="tree-more"
        aria-hidden="true"
        title="More actions"
        onclick={(event) => {
          event.stopPropagation();
          const box = (
            event.currentTarget as HTMLElement
          ).getBoundingClientRect();
          explorer.selected = entry.path;
          onmenu(
            entry,
            box.left,
            box.bottom + 4,
            (event.currentTarget as HTMLElement).parentElement!.querySelector(
              'button',
            )!,
          );
        }}>⋯</span
      >
    </div>
  {/if}
  {#if entry.directory && expanded.includes(entry.path)}<div
      class="tree-children"
      in:rise={{ y: -4, duration: 200 }}
    >
      <Tree
        path={entry.path}
        {changed}
        depth={depth + 1}
        {showHidden}
        {expanded}
        {ontoggle}
        {onopen}
        {ondiscover}
        {onmenu}
        {onaction}
        {oncommit}
      />
    </div>{/if}
{/each}
{#snippet nameField(directory: boolean, initial: string, label: string)}
  <div class="tree-input" style:padding-left={`${26 + depth * 14}px`}>
    <span class="entry-icon" class:directory aria-hidden="true"
      ><Icon name={directory ? 'folder' : 'file'} size={15} /></span
    >
    <input
      aria-label={label}
      aria-invalid={!!explorer.error}
      aria-describedby={explorer.error ? 'tree-input-error' : undefined}
      value={initial}
      disabled={explorer.busy}
      spellcheck="false"
      autocomplete="off"
      use:focusName
      onkeydown={fieldKeys}
      onblur={(event) => fieldBlur(event, initial)}
    />
  </div>
  {#if explorer.error}<p
      id="tree-input-error"
      class="tree-input-error"
      role="alert"
      style:padding-left={`${26 + depth * 14}px`}
    >
      {explorer.error}
    </p>{/if}
{/snippet}
{#if truncated}<p class="tree-note muted">
    Showing the first 2,000 entries.
  </p>{/if}

<style>
  .tree-row {
    gap: 6px;
    min-width: 0;
  }
  .tree-chevron {
    display: flex;
    width: 12px;
    flex: none;
    color: var(--muted);
    opacity: 0.7;
  }
  .entry-icon {
    display: flex;
    flex: none;
    color: var(--muted);
    opacity: 0.8;
  }
  .entry-icon.directory {
    color: color-mix(in srgb, var(--accent) 62%, var(--muted));
  }
  .entry-icon.source {
    color: color-mix(in srgb, var(--accent) 38%, var(--muted));
  }
  .entry-icon.document {
    color: var(--text);
    opacity: 0.65;
  }
  .entry-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-symlink {
    display: flex;
    flex: none;
    color: var(--muted);
    transform: rotate(-45deg);
    opacity: 0.6;
  }
  .tree-item {
    position: relative;
    display: flex;
    border-radius: var(--r-sm);
  }
  .tree-item.selected > .tree-row {
    color: var(--text);
    background: var(--accent-soft);
  }
  .tree-more {
    position: absolute;
    top: 50%;
    right: 4px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    border-radius: var(--r-sm);
    color: var(--muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transform: translateY(-50%);
    transition: opacity 120ms ease;
  }
  .tree-item:hover .tree-more,
  .tree-item:focus-within .tree-more {
    opacity: 1;
  }
  .tree-more:hover {
    color: var(--text);
    background: var(--hover);
  }
  .tree-input {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding-right: 6px;
  }
  .tree-input input {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 2px 6px;
    font-size: var(--fs-sm);
    border-color: var(--accent-line);
    background: var(--bg);
  }
  .tree-input input[aria-invalid='true'] {
    border-color: var(--red);
  }
  .tree-input-error {
    margin: 2px 6px 6px 0;
    font-size: var(--fs-xs);
    color: var(--red);
    line-height: 1.4;
  }
  .changed-dot {
    flex: none;
    width: 6px;
    height: 6px;
    margin-left: auto;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--amber);
    animation: changed-glow 1.4s ease-out 1;
  }
  @keyframes changed-glow {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--amber) 70%, transparent);
      transform: scale(0.4);
    }
    40% {
      transform: scale(1.25);
    }
    100% {
      box-shadow: 0 0 0 7px transparent;
      transform: none;
    }
  }
  .tree-row:hover .entry-icon,
  .tree-row:hover .tree-chevron {
    opacity: 1;
  }
</style>
