<script lang="ts">
  import { untrack } from 'svelte';
  import { contextBytes } from '../fileContext';
  import type { Context } from '../types';
  import Icon from './Icon.svelte';

  let {
    path,
    reference,
    snapshot,
    snapshotError,
    dirty,
    existingIds,
    returnFocus,
    onadd,
    onclose,
  }: {
    path: string;
    reference: Context;
    snapshot: Context | null;
    snapshotError: string;
    dirty: boolean;
    existingIds: string[];
    returnFocus?: HTMLElement;
    onadd: (context: Context) => string | null;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  const previewLimit = 12000;
  let choice = $state<'reference' | 'snapshot'>(
    untrack(() =>
      dirty && snapshot && !snapshotError ? 'snapshot' : 'reference',
    ),
  );
  let error = $state('');
  let accepted = false;
  const snapshotAvailable = $derived(!!snapshot && !snapshotError);
  const candidate = $derived(choice === 'snapshot' ? snapshot : reference);
  const update = $derived(!!candidate && existingIds.includes(candidate.id));
  const filename = $derived(path.split('/').filter(Boolean).at(-1) || path);
  const preview = $derived(candidate?.text.slice(0, previewLimit) ?? '');
  const shortened = $derived((candidate?.text.length ?? 0) > previewLimit);
  const unavailable = $derived(
    snapshotError || 'Open this text file in the editor to capture a snapshot.',
  );
  const submitLabel = $derived(
    `${update ? 'Update' : 'Add'} ${choice === 'snapshot' ? 'editor snapshot' : 'file reference'}`,
  );

  function mount(node: HTMLDialogElement) {
    const trigger =
      returnFocus ?? (document.activeElement as HTMLElement | null);
    node.showModal();
    node.querySelector<HTMLInputElement>('input:checked')?.focus();
    return {
      destroy() {
        node.close();
        if (!accepted && trigger?.isConnected) trigger.focus();
        else
          document
            .querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="Task prompt"]',
            )
            ?.focus();
      },
    };
  }

  function add(event: SubmitEvent) {
    event.preventDefault();
    if (accepted || !candidate || (choice === 'snapshot' && !snapshotAvailable))
      return;
    error = '';
    try {
      const failure = onadd(candidate);
      if (failure !== null) {
        error = failure;
        return;
      }
      accepted = true;
      onclose();
    } catch (cause) {
      error = `Could not add context: ${String(cause)}`;
    }
  }
</script>

<dialog
  class="file-context-picker context-dialog"
  aria-label="Add file context"
  use:mount
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
>
  <form class="context-dialog-shell" onsubmit={add}>
    <header class="context-dialog-heading">
      <div>
        <span class="eyebrow">ADD TO YOUR MESSAGE</span>
        <h2>{filename}</h2>
        <p class="context-dialog-path">{path}</p>
      </div>
      <button
        type="button"
        tabindex="0"
        aria-label="Close file context picker"
        onclick={onclose}><Icon name="close" size={16} /></button
      >
    </header>
    <div class="context-dialog-body">
      <fieldset class="file-context-choices">
        <legend>Choose what to include</legend>
        <label class:chosen={choice === 'reference'}>
          <input
            type="radio"
            name={`${id}-context-kind`}
            value="reference"
            bind:group={choice}
            aria-label="File reference"
            aria-describedby={`${id}-reference-description`}
            tabindex="0"
            onchange={() => (error = '')}
          />
          <span>
            <strong>File reference</strong>
            <small id={`${id}-reference-description`}>
              Points the agent to the file on disk. Unsaved editor changes are
              not included.
            </small>
          </span>
        </label>
        <label
          class:chosen={choice === 'snapshot'}
          class:unavailable={!snapshotAvailable}
        >
          <input
            type="radio"
            name={`${id}-context-kind`}
            value="snapshot"
            bind:group={choice}
            aria-label="Editor snapshot"
            aria-describedby={`${id}-snapshot-description${!snapshotAvailable ? ` ${id}-snapshot-unavailable` : ''}`}
            disabled={!snapshotAvailable}
            tabindex="0"
            onchange={() => (error = '')}
          />
          <span>
            <strong>Editor snapshot</strong>
            <small id={`${id}-snapshot-description`}>
              A frozen copy of this editor buffer{dirty
                ? ', including unsaved changes'
                : ''}. It does not save the file. Later edits do not update this
              copy.
            </small>
          </span>
        </label>
      </fieldset>
      {#if !snapshotAvailable}
        <p
          class="context-dialog-notice"
          id={`${id}-snapshot-unavailable`}
          role="status"
        >
          {unavailable} You can still add a file reference.
        </p>
      {/if}
      <div class="context-preview-caption">
        <span
          >{choice === 'snapshot'
            ? 'Frozen editor text'
            : 'Reference text'}</span
        >
        <span
          >{contextBytes(candidate?.text ?? '').toLocaleString()} bytes · UTF-8</span
        >
      </div>
      <div
        class="context-text-preview file-context-text"
        role="textbox"
        aria-label="File context text"
        aria-readonly="true"
        aria-multiline="true"
        tabindex="0"
      >
        <pre>{preview}</pre>
      </div>
      {#if shortened}
        <p class="context-dialog-note">
          Preview shortened to the first {previewLimit.toLocaleString()}
          characters. The full context will be included.
        </p>
      {/if}
      {#if error}<p class="context-dialog-error" role="alert">{error}</p>{/if}
    </div>
    <footer class="context-dialog-footer">
      <span class="context-dialog-note">
        {update
          ? 'Replaces this item in your message.'
          : 'Adds context to this message.'}
      </span>
      <div class="context-dialog-actions">
        <button type="button" tabindex="0" onclick={onclose}>Cancel</button>
        <button
          class="primary"
          type="submit"
          tabindex="0"
          disabled={!candidate || (choice === 'snapshot' && !snapshotAvailable)}
          >{submitLabel}</button
        >
      </div>
    </footer>
  </form>
</dialog>
