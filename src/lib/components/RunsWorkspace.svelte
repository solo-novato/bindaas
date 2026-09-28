<script lang="ts">
  import { agentName, harnessOf } from '../harness';
  import Icon from './Icon.svelte';
  import type { Thread, Turn } from '../types';
  import {
    historyGroups,
    matchesRunFilter,
    relativeTime,
    runBadge,
    type HistoryFilter,
  } from '../runs';
  import { duration } from '../timeline';
  import { spotlight } from '../motion';
  let {
    multiAgent = false,
    threads,
    turns,
    archived = false,
    pins = [],
    ontogglearchive,
    onrename,
    onpin,
    onarchive,
    selectedId,
    selectedTitle,
    projectName,
    loading,
    loadError,
    opening,
    disabled,
    hasMore,
    hasOlderTurns,
    query = $bindable(''),
    filter = $bindable<HistoryFilter>('all'),
    onrefresh,
    onmore,
    onopen,
    onturn,
    onolder,
    onnew,
    onback,
    onproject,
  }: {
    multiAgent?: boolean;
    threads: Thread[];
    archived?: boolean;
    pins?: string[];
    ontogglearchive: (archived: boolean) => void;
    onrename: (id: string, name: string) => Promise<void>;
    onpin: (id: string) => void;
    onarchive: (id: string) => void;
    turns: Turn[];
    selectedId: string | null;
    selectedTitle: string;
    projectName: string | null;
    loading: boolean;
    loadError: string;
    opening: boolean;
    disabled: boolean;
    hasMore: boolean;
    hasOlderTurns: boolean;
    query?: string;
    filter?: HistoryFilter;
    onrefresh: () => void;
    onmore: () => void;
    onopen: (id: string) => void;
    onturn: (turn: Turn) => void;
    onolder: () => void;
    onnew: () => void;
    onback: () => void;
    onproject: () => void;
  } = $props();
  const filters: { id: HistoryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'running', label: 'Running' },
    { id: 'plans', label: 'Plans' },
    { id: 'completed', label: 'Completed' },
  ];
  let agentFilter = $state('all');
  const matching = $derived(
    threads.filter(
      (thread) =>
        (agentFilter === 'all' || harnessOf(thread.id) === agentFilter) &&
        matchesRunFilter(thread, filter) &&
        `${thread.name ?? ''} ${thread.preview ?? ''}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    ),
  );
  const groups = $derived([
    ...(!archived && matching.some((t) => pins.includes(t.id))
      ? [
          {
            label: 'Pinned',
            threads: matching.filter((t) => pins.includes(t.id)),
          },
        ]
      : []),
    ...historyGroups(
      matching.filter((t) => archived || !pins.includes(t.id)),
      filter === 'all',
    ),
  ]);
  let renaming = $state<string | null>(null);
  let title = $state('');
  let renameBusy = $state(false);
  let renameError = $state('');
  async function saveTitle() {
    if (!renaming || renameBusy || !title.trim()) return;
    renameBusy = true;
    renameError = '';
    try {
      await onrename(renaming, title.trim());
      renaming = null;
    } catch (e) {
      renameError = String(e);
    } finally {
      renameBusy = false;
    }
  }
  let turnFilter = $state('all');
  function reset() {
    query = '';
    filter = 'all';
    agentFilter = 'all';
  }
  function date(seconds?: number) {
    return seconds
      ? new Date(seconds * 1000).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'Date not recorded';
  }
</script>

<section class="runs" aria-label="Conversation history">
  <div class="runs-content">
    <header class="runs-heading">
      <div>
        <h1>History</h1>
        <p class="muted">
          {projectName
            ? `Conversations in ${projectName}. Work that needs a decision comes first.`
            : 'Conversations stay with their project.'}
        </p>
      </div>
      <div class="runs-heading-actions">
        {#if multiAgent}<select
            aria-label="Filter conversations by agent"
            bind:value={agentFilter}
            ><option value="all">All agents</option><option value="codex"
              >Codex</option
            ><option value="claude">Claude</option></select
          >{/if}
        {#if selectedId}<button onclick={onback}
            >Back to conversation <Icon name="arrow-right" size={14} /></button
          >{/if}
        <button disabled={!projectName || loading} onclick={onrefresh}
          ><Icon name="refresh" size={14} /> Refresh</button
        >
      </div>
    </header>
    {#if !projectName}
      <div class="runs-empty">
        <span aria-hidden="true"><Icon name="folder-open" size={36} /></span>
        <h2>Open a project to see its history</h2>
        <p>
          Conversations stay with their project, so you can return to the right
          context.
        </p>
        <button class="primary" onclick={onproject}>Open a project</button>
      </div>
    {:else}
      <div class="runs-toolbar">
        <div
          class="runs-collection segmented"
          role="group"
          aria-label="Conversation collection"
        >
          <button
            aria-pressed={!archived}
            disabled={loading || disabled}
            onclick={() => ontogglearchive(false)}>Conversations</button
          >
          <button
            aria-pressed={archived}
            disabled={loading || disabled}
            onclick={() => ontogglearchive(true)}>Archived</button
          >
        </div>
        <div class="runs-search">
          <span aria-hidden="true"><Icon name="search" size={17} /></span><input
            type="search"
            aria-label="Search conversations"
            placeholder="Search titles and opening messages…"
            bind:value={query}
          />{#if query}<button
              aria-label="Clear conversation search"
              onclick={() => (query = '')}
              ><Icon name="close" size={14} /></button
            >{/if}
        </div>
        <p class="runs-count" aria-live="polite">
          {matching.length} of {threads.length} loaded{#if loading}
            · Refreshing…{/if}
        </p>
      </div>
      <div class="runs-filters" role="group" aria-label="Conversation status">
        {#each filters as option}<button
            aria-pressed={filter === option.id}
            onclick={() => (filter = option.id)}
            >{option.label}<span
              >{threads.filter((thread) => matchesRunFilter(thread, option.id))
                .length}</span
            ></button
          >{/each}
      </div>
      {#if opening}<p class="runs-loading" role="status">
          Opening conversation…
        </p>{/if}
      {#if loadError}<div class="runs-error" role="alert">
          <div>
            <strong>Could not load conversation history</strong>
            <p>{loadError}</p>
            {#if threads.length}<small
                >Your loaded conversations are still available.</small
              >{/if}
          </div>
          <button disabled={loading} onclick={onrefresh}>Retry history</button>
        </div>{/if}
      {#if loading && !threads.length}<div
          class="runs-skeleton"
          role="status"
          aria-label="Loading your conversations"
        >
          {#each Array(6) as _, n}<div class="skeleton-row" style={`--i:${n}`}>
              <span class="skeleton skeleton-icon"></span><span
                class="skeleton skeleton-line"
                style={`width:${52 - n * 5}%`}
              ></span><span class="skeleton skeleton-pill"></span>
            </div>{/each}
        </div>
      {:else if !threads.length && !loadError}<div class="runs-empty">
          <span aria-hidden="true"><Icon name="chat" size={36} /></span>
          <h2>
            {archived
              ? 'No archived conversations'
              : 'Your next idea starts here'}
          </h2>
          <p>
            {archived
              ? 'Conversations you archive will appear here, ready to restore.'
              : 'Start a task and this space will keep a path back to your work.'}
          </p>
          {#if !archived}<button class="primary" {disabled} onclick={onnew}
              >Start a new task</button
            >{/if}
        </div>
      {:else if threads.length && !matching.length}<div class="runs-empty">
          <h2>No matching conversations</h2>
          <p>
            Try a different title or status.{#if hasMore}
              You can also load older conversations below.{/if}
          </p>
          <button onclick={reset}>Clear filters</button>
        </div>
      {:else}<div class="runs-groups" use:spotlight>
          {#each groups as group}<section
              class="runs-group"
              aria-label={group.label}
            >
              <h2>{group.label}<span>{group.threads.length}</span></h2>
              {#each group.threads as thread, n (thread.id)}{@const badge =
                  runBadge(thread)}
                <div
                  class="conversation-row"
                  data-spotlight
                  style={`--i:${Math.min(n, 12)}`}
                >
                  <button
                    class="thread-row"
                    class:current={selectedId === thread.id}
                    aria-current={selectedId === thread.id ? 'true' : undefined}
                    disabled={disabled || archived}
                    onclick={() => {
                      if (!archived) onopen(thread.id);
                    }}
                    title={archived
                      ? 'Restore this conversation to open it'
                      : undefined}
                  >
                    <span
                      class="thread-icon"
                      data-tone={badge.tone}
                      aria-hidden="true"
                      >{#if badge.tone === 'attention'}?{:else if badge.tone === 'error'}!{:else if badge.tone === 'active'}●{:else}<Icon
                          name={badge.tone === 'plan'
                            ? 'file'
                            : badge.tone === 'success'
                              ? 'check'
                              : 'history'}
                          size={16}
                        />{/if}</span
                    >
                    <div class="thread-main">
                      <strong
                        >{thread.name ||
                          thread.preview ||
                          'Untitled conversation'}</strong
                      >{#if selectedId === thread.id}<span
                          class="thread-current"
                        >
                          Current</span
                        >{/if}
                      {#if thread.name && thread.preview && thread.preview !== thread.name}<p
                          class="thread-preview"
                        >
                          {thread.preview}
                        </p>{/if}
                    </div>
                    {#if multiAgent || thread.model}<small class="thread-meta"
                        >{#if multiAgent}<span class="agent-badge"
                            >{agentName(harnessOf(thread.id))}</span
                          >{/if}{#if multiAgent && thread.model}
                          ·
                        {/if}{thread.model ?? ''}</small
                      >{/if}
                    <span
                      class="run-badge"
                      data-tone={badge.tone}
                      aria-label={`Run status: ${badge.label}`}
                      >{badge.label}</span
                    ><time
                      class="thread-time"
                      title={date(thread.updatedAt)}
                      datetime={new Date(thread.updatedAt * 1000).toISOString()}
                      >{relativeTime(thread.updatedAt)}</time
                    >
                  </button>
                  <div
                    class="conversation-actions"
                    aria-label={`Manage ${thread.name || thread.preview || 'conversation'}`}
                  >
                    {#if !archived}<button
                        {disabled}
                        aria-pressed={pins.includes(thread.id)}
                        onclick={() => onpin(thread.id)}
                        >{pins.includes(thread.id) ? 'Unpin' : 'Pin'}</button
                      >{/if}
                    <button
                      {disabled}
                      onclick={() => {
                        renaming = thread.id;
                        title = thread.name || thread.preview || '';
                        renameError = '';
                      }}>Rename</button
                    >
                    <button
                      disabled={disabled ||
                        (!archived &&
                          [
                            'running',
                            'waitingInput',
                            'waitingApproval',
                            'waiting',
                          ].includes(thread.runStatus ?? ''))}
                      onclick={() => onarchive(thread.id)}
                      >{archived ? 'Restore' : 'Archive'}</button
                    >
                  </div>
                  {#if renaming === thread.id}<form
                      class="rename-conversation"
                      onsubmit={(e) => {
                        e.preventDefault();
                        void saveTitle();
                      }}
                    >
                      <input
                        aria-label="Conversation title"
                        maxlength="200"
                        bind:value={title}
                        disabled={renameBusy}
                      />
                      <button
                        class="primary"
                        disabled={renameBusy || !title.trim()}
                        >Save title</button
                      >
                      <button
                        type="button"
                        disabled={renameBusy}
                        onclick={() => (renaming = null)}>Cancel</button
                      >
                      {#if renameError}<p role="alert">{renameError}</p>{/if}
                    </form>{/if}
                </div>
              {/each}
            </section>{/each}
        </div>{/if}
      {#if hasMore}<div class="runs-pagination">
          <p class="muted">
            Search and filters cover the conversations loaded so far.
          </p>
          <button disabled={loading || opening} onclick={onmore}
            >{loading ? 'Loading…' : 'Load older conversations'}</button
          >
        </div>{/if}
      {#if selectedId && turns.length}<details class="runs-turns">
          <summary
            >Tasks in {selectedTitle || 'the selected conversation'}<span
              >{turns.length} loaded <Icon
                name="chevron-down"
                size={14}
              /></span
            ></summary
          >
          <div class="runs-turns-heading">
            <p class="muted">Open an earlier task without starting new work.</p>
            <select aria-label="Filter task status" bind:value={turnFilter}
              >{#each ['all', 'completed', 'failed', 'interrupted'] as status}<option
                  value={status}
                  >{status === 'all'
                    ? 'All outcomes'
                    : status[0].toUpperCase() + status.slice(1)}</option
                >{/each}</select
            >
          </div>
          {#each turns.filter((turn) => turnFilter === 'all' || turn.status === turnFilter) as turn}
            <button class="thread-row" {disabled} onclick={() => onturn(turn)}
              ><div>
                <strong
                  >{turn.items?.find((item) => item.kind === 'user')?.text ||
                    `Task · ${date(turn.startedAt)}`}</strong
                ><small
                  >{turn.status[0].toUpperCase() + turn.status.slice(1)} · {duration(
                    turn.durationMs,
                  )}</small
                >
              </div>
              <Icon name="arrow-right" size={16} /></button
            >
          {:else}<p class="muted">No loaded tasks have this outcome.</p>{/each}
          {#if hasOlderTurns}<button
              disabled={loading || opening}
              onclick={onolder}>Load older tasks</button
            >{/if}
        </details>{/if}
    {/if}
  </div>
</section>
