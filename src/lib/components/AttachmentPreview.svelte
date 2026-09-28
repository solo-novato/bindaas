<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api';
  import type { Attachment, AttachmentPreview } from '../types';
  let {
    attachment,
    returnFocus,
    onclose,
    onremove,
  }: {
    attachment: Attachment;
    returnFocus?: HTMLElement;
    onclose: () => void;
    onremove: () => void;
  } = $props();
  let preview = $state<AttachmentPreview | null>(null);
  let loading = $state(true);
  let error = $state('');
  let imageError = $state(false);
  let actualSize = $state(false);
  let dimensions = $state('');
  let alive = true;
  let removing = false;
  let request = 0;
  async function load() {
    const version = ++request;
    loading = true;
    error = '';
    preview = null;
    imageError = false;
    try {
      const value = await api.previewAttachment(attachment.id);
      if (alive && version === request) preview = value;
    } catch (e) {
      if (alive && version === request) error = String(e);
    } finally {
      if (alive && version === request) loading = false;
    }
  }
  onMount(() => {
    load();
    return () => {
      alive = false;
    };
  });
  function mount(node: HTMLDialogElement) {
    const previous =
      returnFocus ?? (document.activeElement as HTMLElement | null);
    node.showModal();
    return {
      destroy() {
        node.close();
        if (!removing && previous?.isConnected) previous.focus();
        else
          document
            .querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="Task prompt"]',
            )
            ?.focus();
      },
    };
  }
</script>

<dialog
  class="attachment-preview"
  use:mount
  aria-label="Attachment preview"
  oncancel={(e) => {
    e.preventDefault();
    onclose();
  }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div class="attachment-preview-shell">
    <header>
      <div>
        <span class="eyebrow">ATTACHED TO YOUR MESSAGE</span>
        <h2>{attachment.name}</h2>
        <p>
          {attachment.kind === 'image' ? 'Image' : 'File'} · {(
            attachment.sizeBytes / 1024
          ).toFixed(1)} KiB{dimensions ? ` · ${dimensions}` : ''}
        </p>
      </div>
      <button aria-label="Close attachment preview" onclick={onclose}>×</button>
    </header>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable preview needs keyboard focus.) -->
    <div
      role="region"
      aria-label="Attachment contents"
      tabindex="0"
      class="attachment-preview-body"
      class:actual-size={actualSize}
      aria-busy={loading}
    >
      {#if loading}<p class="attachment-preview-notice" role="status">
          Loading attachment…
        </p>
      {:else if error}<div class="attachment-preview-notice" role="alert">
          <p>{error}</p>
          <button onclick={load}>Retry preview</button>
        </div>
      {:else if preview?.kind === 'image'}
        {#if imageError}<p class="attachment-preview-notice" role="status">
            This image could not be displayed. You can remove it and attach
            another copy.
          </p>
        {:else}<img
            src={preview.dataUrl}
            alt={attachment.name}
            onload={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              dimensions = `${img.naturalWidth} × ${img.naturalHeight}`;
            }}
            onerror={() => (imageError = true)}
          />{/if}
      {:else if preview?.kind === 'text'}
        {#if preview.text}<pre
            aria-label="Attached file text">{preview.text}</pre>
        {:else}<p class="attachment-preview-notice">
            This text file is empty.
          </p>{/if}
      {:else if preview?.kind === 'unavailable'}<p
          class="attachment-preview-notice"
        >
          {preview.message}
        </p>{/if}
    </div>
    <footer>
      <div class="attachment-preview-options">
        {#if preview?.kind === 'image' && !imageError}<button
            aria-pressed={actualSize}
            onclick={() => (actualSize = !actualSize)}
            >{actualSize ? 'Fit image' : 'Actual size'}</button
          >{/if}
        {#if preview?.kind === 'text' && preview.truncated}<span class="muted"
            >First 64 KiB shown · full file stays attached</span
          >{/if}
      </div>
      <button
        class="attachment-remove"
        onclick={() => {
          removing = true;
          onremove();
        }}>Remove attachment</button
      >
      <button class="primary" onclick={onclose}>Back to message</button>
    </footer>
  </div>
</dialog>
