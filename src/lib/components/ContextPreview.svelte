<script module lang="ts">
  // Clipboard writes cannot be cancelled. Keep one in flight across modal lifetimes.
  let clipboardWritePending = $state(false);
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { contextBytes } from '../fileContext';
  import type { Context } from '../types';
  import Icon from './Icon.svelte';

  let {
    context,
    canUpdate,
    updateHint,
    returnFocus,
    onupdate,
    onremove,
    onclose,
  }: {
    context: Context;
    canUpdate: boolean;
    updateHint: string;
    returnFocus?: HTMLElement;
    onupdate: () => string | null;
    onremove: () => void;
    onclose: () => void;
  } = $props();

  const id = $props.id();
  const previewLimit = 30000;
  let alive = true;
  let removing = false;
  let copyRequest = 0;
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
  let error = $state('');
  let updateStatus = $state('');
  const file = $derived(context.file);
  const preview = $derived(context.text.slice(0, previewLimit));
  const shortened = $derived(context.text.length > previewLimit);
  const updateLabel = $derived(
    file?.kind === 'reference'
      ? 'Replace with editor snapshot'
      : 'Update from editor',
  );
  const updatableKind = $derived(
    !!file && file.kind !== 'selection' && !file.directory,
  );
  const sourceLabel = $derived(
    file?.kind === 'reference'
      ? file.directory
        ? 'Folder reference'
        : 'File reference'
      : file?.kind === 'snapshot'
        ? 'Editor snapshot'
        : file?.kind === 'selection'
          ? 'Editor selection'
          : 'Message context',
  );

  $effect(() => {
    context.id;
    context.text;
    untrack(() => {
      copyRequest += 1;
      copyState = 'idle';
    });
  });

  function mount(node: HTMLDialogElement) {
    const trigger =
      returnFocus ?? (document.activeElement as HTMLElement | null);
    node.showModal();
    node
      .querySelector<HTMLButtonElement>('[aria-label="Close context preview"]')
      ?.focus();
    return {
      destroy() {
        alive = false;
        copyRequest += 1;
        node.close();
        if (!removing && trigger?.isConnected) trigger.focus();
        else
          document
            .querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="Task prompt"]',
            )
            ?.focus();
      },
    };
  }

  function close() {
    alive = false;
    copyRequest += 1;
    onclose();
  }

  async function copy() {
    if (!alive || clipboardWritePending) return;
    const request = ++copyRequest;
    const text = context.text;
    const contextId = context.id;
    clipboardWritePending = true;
    copyState = 'idle';
    try {
      await navigator.clipboard.writeText(text);
      if (
        alive &&
        request === copyRequest &&
        text === context.text &&
        contextId === context.id
      )
        copyState = 'copied';
    } catch {
      if (
        alive &&
        request === copyRequest &&
        text === context.text &&
        contextId === context.id
      )
        copyState = 'failed';
    } finally {
      clipboardWritePending = false;
    }
  }

  function update() {
    if (!canUpdate || !updatableKind) return;
    error = '';
    updateStatus = '';
    copyRequest += 1;
    copyState = 'idle';
    try {
      const failure = onupdate();
      if (failure !== null) error = failure;
      else updateStatus = 'Editor snapshot updated.';
    } catch (cause) {
      error = `Could not update context: ${String(cause)}`;
    }
  }

  function remove() {
    removing = true;
    alive = false;
    copyRequest += 1;
    onremove();
  }
</script>

<dialog
  class="context-preview context-dialog"
  aria-label="Context preview"
  use:mount
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <div class="context-dialog-shell">
    <header class="context-dialog-heading">
      <div>
        <span class="eyebrow">INCLUDED IN YOUR MESSAGE</span>
        <h2>{context.label}</h2>
        {#if file}<p class="context-dialog-path">{file.path}</p>{/if}
      </div>
      <button tabindex="0" aria-label="Close context preview" onclick={close}
        ><Icon name="close" size={16} /></button
      >
    </header>
    <div class="context-dialog-body">
      <dl class="context-provenance">
        <div>
          <dt>Source</dt>
          <dd>{sourceLabel}</dd>
        </div>
        {#if file}
          <div>
            <dt>Project</dt>
            <dd>{file.projectRoot}</dd>
          </div>
          {#if file.kind !== 'reference'}
            <div>
              <dt>Captured from</dt>
              <dd>
                {file.dirty === undefined
                  ? 'Editor buffer'
                  : file.dirty
                    ? 'Unsaved editor changes'
                    : 'Saved editor buffer'}
              </dd>
            </div>
          {/if}
          {#if file.fromLine !== undefined}
            <div>
              <dt>Lines</dt>
              <dd>
                {file.fromLine}{file.toLine !== undefined &&
                file.toLine !== file.fromLine
                  ? `–${file.toLine}`
                  : ''}
              </dd>
            </div>
          {/if}
        {/if}
        <div>
          <dt>Size</dt>
          <dd>{contextBytes(context.text).toLocaleString()} bytes · UTF-8</dd>
        </div>
      </dl>
      {#if file?.kind === 'reference'}
        <p class="context-dialog-note">
          The agent reads {file.directory ? 'this folder' : 'this file'} from disk.
          Unsaved editor changes are not included.
        </p>
      {:else if file?.kind === 'snapshot'}
        <p class="context-dialog-note">
          This is a frozen editor snapshot. It does not save the file, and later
          edits do not update this copy.
        </p>
      {:else if file?.kind === 'selection'}
        <p class="context-dialog-note">
          This is a frozen editor selection. Later edits do not update this
          copy. Reselect text in the editor to add a new selection.
        </p>
      {/if}
      <div
        class="context-text-preview"
        role="textbox"
        aria-label="Context text"
        aria-readonly="true"
        aria-multiline="true"
        tabindex="0"
      >
        <pre>{preview}</pre>
      </div>
      {#if shortened}
        <p class="context-dialog-note">
          Preview shortened to the first {previewLimit.toLocaleString()}
          characters. The full context stays attached and is copied by Copy context.
        </p>
      {/if}
      {#if updatableKind}
        <div class="context-update-row">
          <button
            tabindex="0"
            disabled={!canUpdate}
            aria-describedby={!canUpdate ? `${id}-update-hint` : undefined}
            onclick={update}>{updateLabel}</button
          >
          {#if !canUpdate}
            <p class="context-dialog-note" id={`${id}-update-hint`}>
              {updateHint ||
                'Open this file in the editor to capture a new snapshot.'}
            </p>
          {/if}
        </div>
      {/if}
      {#if error}<p class="context-dialog-error" role="alert">{error}</p>{/if}
      {#if updateStatus}<p class="context-dialog-note" role="status">
          {updateStatus}
        </p>{/if}
      <div class="context-copy-status" aria-live="polite" aria-atomic="true">
        {#if copyState === 'copied'}<span>Full context copied.</span>
        {:else if copyState === 'failed'}<span class="error"
            >Could not copy context. Please try again.</span
          >{/if}
      </div>
    </div>
    <footer class="context-dialog-footer">
      <button tabindex="0" disabled={clipboardWritePending} onclick={copy}>
        {clipboardWritePending ? 'Copying…' : 'Copy context'}
      </button>
      <div class="context-dialog-actions">
        <button tabindex="0" onclick={remove}>Remove context</button>
        <button class="primary" tabindex="0" onclick={close}
          >Back to message</button
        >
      </div>
    </footer>
  </div>
</dialog>
