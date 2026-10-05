<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../api';
  import {
    editor,
    currentTab,
    reloadTab,
    saveComparedTab,
  } from '../editor.svelte';
  import { editorText } from '../text';
  import type { FileData, Tab } from '../types';
  import Icon from './Icon.svelte';

  let { tab, onclose }: { tab: Tab; onclose: () => void } = $props();
  // One on-demand snapshot; closing or leaving this tab releases it. No second
  // editor runtime or background file reader is needed for conflict recovery.
  const previewLimit = 65_536;
  const path = untrack(() => tab.path);
  let disk = $state<FileData | null>(null);
  let loading = $state(false);
  let failure = $state('');
  let invalidated = $state(false);
  let copyStatus = $state('');
  let request = 0;
  let mounted = false;
  let heading: HTMLHeadingElement;
  const localText = $derived(tab.content ?? '');
  const diskText = $derived(
    disk?.content == null ? '' : editorText(disk.content),
  );
  const truncated = $derived(
    localText.length > previewLimit || diskText.length > previewLimit,
  );
  const busy = $derived(!!tab.saving || !!tab.reloading);
  const canSave = $derived(
    !!disk && !loading && !busy && !truncated && !invalidated && tab.dirty,
  );

  function current() {
    return (
      mounted &&
      tab.path === path &&
      currentTab() === tab &&
      editor.tabs.includes(tab)
    );
  }
  async function refreshDisk() {
    const ticket = ++request;
    loading = true;
    invalidated = true;
    failure = '';
    try {
      const result = await api.read(path);
      if (!current() || ticket !== request) return;
      if (result.path !== path)
        throw new Error(
          'The disk response belongs to another file. Refresh to try again.',
        );
      if (result.encoding !== 'utf8' || result.content === null)
        throw new Error(
          result.encoding === 'binary'
            ? 'The disk version is a binary file. Your unsaved text is preserved; it cannot safely replace this version here.'
            : 'The disk version is too large or unavailable to preview. Your unsaved text is preserved.',
        );
      disk = result;
      invalidated = false;
    } catch (error) {
      if (current() && ticket === request) failure = String(error);
    } finally {
      if (current() && ticket === request) loading = false;
    }
  }
  async function copyLocal() {
    const text = localText;
    copyStatus = '';
    try {
      await navigator.clipboard.writeText(text);
      if (current()) copyStatus = 'Copied full local text';
    } catch {
      if (current())
        copyStatus = 'Could not copy. Your text is still in the editor.';
    }
  }
  async function saveLocal() {
    if (!current() || !canSave || !disk) return;
    const outcome = await saveComparedTab(tab, disk);
    if (!current()) return;
    if (outcome === 'saved') onclose();
    else if (outcome === 'failed') {
      // Retain both versions for reference, but require a new explicit snapshot
      // before trying to replace a file that may have changed again.
      invalidated = true;
      failure = `${tab.conflict ?? 'The file could not be saved'}. The shown disk snapshot may be out of date. Refresh disk to compare again. Your text is preserved.`;
    }
  }
  async function useDisk() {
    if (!current() || busy) return;
    if (await reloadTab(tab)) {
      if (current()) onclose();
    }
  }
  onMount(() => {
    mounted = true;
    heading?.focus({ preventScroll: true });
    void refreshDisk();
    return () => {
      mounted = false;
      request++;
    };
  });
</script>

<section
  class="compare"
  aria-label="File conflict comparison"
  aria-busy={loading}
>
  <header class="compare-heading">
    <div>
      <span class="eyebrow">Resolve a file conflict</span>
      <h2 title={path} tabindex="-1" bind:this={heading}>{path}</h2>
      <p>
        Your edits are safe in this window. Review both versions before choosing
        what to keep.
      </p>
    </div>
    <button onclick={onclose} aria-label="Close comparison"
      ><Icon name="close" size={15} />Close comparison</button
    >
  </header>
  <div class="compare-toolbar">
    <span class="muted"
      >{loading
        ? disk
          ? 'Refreshing disk · showing the earlier snapshot'
          : 'Reading the current disk version…'
        : disk
          ? invalidated
            ? 'Earlier disk snapshot · refresh before saving'
            : 'Disk snapshot · refresh if the agent edits again'
          : 'No safe disk snapshot available'}</span
    >
    <button disabled={busy} onclick={refreshDisk}
      ><Icon name="refresh" size={14} />Refresh disk</button
    >
    <button onclick={copyLocal}>Copy my text</button>
  </div>
  {#if failure}<p class="compare-notice error" role="alert">{failure}</p>{/if}
  {#if copyStatus}<p class="compare-notice" role="status">{copyStatus}</p>{/if}
  {#if truncated}<p class="compare-notice warning" role="status">
      Preview limited to 65,536 characters per version. Copy my text includes
      your full buffer. Saving your version here is disabled until both versions
      can be reviewed completely.
    </p>{/if}
  <div class="compare-columns">
    <section aria-label="Your unsaved content" class="compare-local">
      <div class="compare-column-heading">
        <h3>Your unsaved content</h3>
        <span
          >{localText.length.toLocaleString()} characters · kept in memory</span
        >
      </div>
      <div
        class="compare-text"
        role="textbox"
        aria-readonly="true"
        aria-multiline="true"
        tabindex="0"
        aria-label="Your unsaved text"
      >
        <pre>{localText.slice(0, previewLimit)}</pre>
      </div>
    </section>
    <section aria-label="Current disk content">
      <div class="compare-column-heading">
        <h3>Current disk content</h3>
        <span
          >{disk
            ? `${diskText.length.toLocaleString()} characters · ${disk.newline.toUpperCase()}`
            : loading
              ? 'Loading…'
              : 'Unavailable'}</span
        >
      </div>
      {#if disk}<div
          class="compare-text"
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          tabindex="0"
          aria-label="Compared disk text"
        >
          <pre>{diskText.slice(0, previewLimit)}</pre>
        </div>{:else}<div class="compare-placeholder" role="status">
          {loading
            ? 'Reading disk…'
            : 'Refresh disk to try again. Your unsaved version has not changed.'}
        </div>{/if}
    </section>
  </div>
  <footer class="compare-actions">
    <p>
      Saving your version replaces only the disk snapshot you reviewed. A newer
      disk change will block the save.
    </p>
    <button disabled={busy} onclick={onclose}>Keep editing</button>
    <button disabled={busy || loading} onclick={useDisk}>Reload disk</button>
    <button class="primary" disabled={!canSave} onclick={saveLocal}
      >{tab.saving ? 'Saving…' : 'Save my version…'}</button
    >
  </footer>
</section>
