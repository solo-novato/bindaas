<script lang="ts">
  import { tick } from 'svelte';
  import type { TaskQueue } from '../queue';
  import type { Draft } from '../types';
  import Icon from './Icon.svelte';

  let {
    queue,
    active,
    claude,
    agentLabel,
    navigationBusy,
    onsend,
    onpause,
    onresume,
    onbeginedit,
    oneditprompt,
    oncanceledit,
    onedit,
    onremove,
    onmove,
  }: {
    queue: TaskQueue;
    active: boolean;
    claude: boolean;
    agentLabel: string;
    navigationBusy: boolean;
    onsend: () => void;
    onpause: () => void;
    onresume: () => void;
    onbeginedit: (id: string) => void;
    oneditprompt: (prompt: string) => void;
    oncanceledit: () => void;
    onedit: (id: string, prompt: string) => void;
    onremove: (id: string) => void;
    onmove: (id: string, direction: -1 | 1) => void;
  } = $props();

  const listId = $props.id();
  let expanded = $state(false);
  const editingId = $derived(queue.editing?.id ?? null);
  const editPrompt = $derived(queue.editing?.prompt ?? '');
  const showAll = $derived(
    expanded || (!!editingId && queue.entries[0]?.id !== editingId),
  );
  let editor = $state<HTMLTextAreaElement>();
  const busy = $derived(navigationBusy || !!queue.sendingId);
  const visibleEntries = $derived(
    showAll ? queue.entries : queue.entries.slice(0, 1),
  );
  const status = $derived(
    queue.sendingId
      ? 'Sending first task…'
      : editingId
        ? 'Paused while you edit'
        : queue.error
          ? 'Paused · Send now to retry'
          : queue.paused
            ? 'Paused · resume when ready'
            : active
              ? 'Runs after the current turn'
              : 'Ready for the next turn',
  );
  const sendHint = $derived(
    active
      ? claude
        ? 'Claude receives queued tasks after the current turn and its background work finish.'
        : 'Send the first queued task into the running turn, using its current mode and settings.'
      : 'Send the first queued task as a follow-up.',
  );

  function modeLabel(draft: Draft) {
    return draft.mode === 'plan'
      ? 'Plan'
      : draft.mode === 'default'
        ? 'Code'
        : `${agentLabel} settings`;
  }

  function revealEditor(node: HTMLTextAreaElement) {
    void tick().then(() => node.scrollIntoView({ block: 'nearest' }));
  }

  async function beginEdit(id: string) {
    if (busy || editingId) return;
    onbeginedit(id);
    await tick();
    editor?.focus();
  }

  async function restoreEditFocus(id: string | null) {
    await tick();
    document
      .getElementById(`${listId}-edit-${id}`)
      ?.focus({ preventScroll: true });
  }

  function closeEditor() {
    const id = editingId;
    expanded = showAll;
    oncanceledit();
    void restoreEditFocus(id);
  }

  function saveEdit() {
    const entry = queue.entries.find((entry) => entry.id === editingId);
    if (
      !entry ||
      busy ||
      (!editPrompt.trim() &&
        !entry.draft.attachments.length &&
        !entry.draft.contexts.length)
    )
      return;
    expanded = showAll;
    onedit(entry.id, editPrompt);
    void restoreEditFocus(entry.id);
  }
</script>

<section
  class="queue-card"
  class:queue-expanded={showAll}
  class:queue-editing={editingId !== null}
  aria-label={queue.entries.length === 1 ? 'Queued message' : 'Task queue'}
  aria-busy={!!queue.sendingId}
>
  <div class="queue-heading">
    <div class="queue-title">
      <strong>Task queue</strong>
      <span class="queue-count">{queue.entries.length} queued</span>
      {#if queue.paused}<span class="queue-paused">Paused</span>{/if}
    </div>
    <div class="queue-heading-actions">
      <button
        class="queue-pause"
        disabled={busy || editingId !== null}
        onclick={queue.paused ? onresume : onpause}
      >
        <span
          class:queue-play-glyph={queue.paused}
          class:queue-pause-glyph={!queue.paused}
          aria-hidden="true"
        ></span>
        {queue.paused ? 'Resume queue' : 'Pause queue'}
      </button>
      {#if queue.entries.length > 1}
        <button
          class="queue-expand"
          aria-expanded={showAll}
          aria-controls={listId}
          disabled={editingId !== null}
          onclick={() => (expanded = !expanded)}
        >
          {showAll ? 'Show less' : `Show all ${queue.entries.length}`}
          <Icon name="chevron-down" size={13} />
        </button>
      {/if}
    </div>
  </div>

  <ol class="queue-list" id={listId} aria-label="Queued tasks">
    {#each visibleEntries as entry, index (entry.id)}
      <li
        class="queue-entry"
        class:queue-entry-editing={editingId === entry.id}
        class:queue-entry-sending={queue.sendingId === entry.id}
        aria-label={`Queued task ${index + 1}`}
      >
        <span class="queue-position" aria-hidden="true">{index + 1}</span>
        <div class="queue-entry-body">
          {#if editingId === entry.id}
            <div class="queue-editor">
              <textarea
                use:revealEditor
                bind:this={editor}
                value={editPrompt}
                oninput={(event) => oneditprompt(event.currentTarget.value)}
                aria-label="Edit queued message"
                rows="3"
                onkeydown={(event) => {
                  if (event.key === 'Escape' && !event.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    void closeEditor();
                  } else if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!event.isComposing) saveEdit();
                  }
                }}
              ></textarea>
              <div class="queue-edit-actions">
                <button
                  class="primary"
                  disabled={busy ||
                    (!editPrompt.trim() &&
                      !entry.draft.attachments.length &&
                      !entry.draft.contexts.length)}
                  onclick={saveEdit}>Save changes</button
                >
                <button onclick={() => void closeEditor()}>Cancel</button>
                <span>Queue stays paused</span>
              </div>
            </div>
          {:else}
            <p class="queue-prompt" title={entry.draft.prompt}>
              {entry.draft.prompt || 'Attached context'}
            </p>
          {/if}
          <div class="queue-context">
            <span
              class="queue-mode"
              class:queue-mode-plan={entry.draft.mode === 'plan'}
            >
              {modeLabel(entry.draft)}
            </span>
            {#if index === 0}<span class="queue-next">Next up</span>{/if}
            {#each entry.draft.attachments as attachment (attachment.id)}
              <span class="queue-chip" title={attachment.name}>
                <Icon name="paperclip" size={11} />
                <span>{attachment.name}</span>
              </span>
            {/each}
            {#each entry.draft.contexts as context (context.id)}
              <span class="queue-chip" title={context.label}>
                <Icon name="file" size={11} />
                <span>{context.label}</span>
              </span>
            {/each}
          </div>
        </div>
        {#if editingId !== entry.id}
          <div class="queue-entry-actions">
            {#if queue.entries.length > 1}
              <div class="queue-move-controls">
                <button
                  class="queue-move"
                  aria-label="Move up"
                  title={`Move task ${index + 1} up`}
                  disabled={busy || editingId !== null || index === 0}
                  onclick={() => onmove(entry.id, -1)}
                  ><Icon name="arrow-up" size={13} /></button
                >
                <button
                  class="queue-move queue-move-down"
                  aria-label="Move down"
                  title={`Move task ${index + 1} down`}
                  disabled={busy ||
                    editingId !== null ||
                    index === queue.entries.length - 1}
                  onclick={() => onmove(entry.id, 1)}
                  ><Icon name="arrow-up" size={13} /></button
                >
              </div>
            {/if}
            <button
              id={`${listId}-edit-${entry.id}`}
              disabled={busy || editingId !== null}
              onclick={() => void beginEdit(entry.id)}>Edit</button
            >
            <button
              class="queue-remove"
              disabled={busy || editingId !== null}
              onclick={() => onremove(entry.id)}>Remove</button
            >
          </div>
        {/if}
      </li>
    {/each}
  </ol>

  {#if queue.error}<p class="queue-error" role="alert">{queue.error}</p>{/if}
  <div class="queue-actions">
    <small role="status" title={sendHint}>{status}</small>
    <button
      class="primary"
      title={sendHint}
      disabled={busy || editingId !== null || (active && claude)}
      onclick={onsend}>Send now<Icon name="arrow-right" size={13} /></button
    >
  </div>
</section>
