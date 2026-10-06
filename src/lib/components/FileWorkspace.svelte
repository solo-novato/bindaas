<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import {
    editor,
    currentTab,
    editContent,
    openFile,
    closeTab,
    saveTab,
    reloadTab,
  } from '../editor.svelte';
  import { api } from '../api';
  import { ask } from '../dialog.svelte';
  import type { Context, Tab } from '../types';
  let {
    activeTask,
    oncontext,
  }: { activeTask: boolean; oncontext: (context: Context) => void } = $props();
  const tab = $derived(currentTab());
  let workspace: HTMLDivElement;
  let comparisonFor = $state<Tab | null>(null);
  let comparisonPath = $state('');
  const loadConflictReview = () => import('./FileConflictReview.svelte');
  let conflictComponent = $state<ReturnType<typeof loadConflictReview> | null>(
    null,
  );
  $effect(() => {
    if (
      comparisonFor &&
      (comparisonFor !== tab || comparisonPath !== tab?.path)
    )
      comparisonFor = null;
  });
  const loadEditor = () => import('./CodeEditor.svelte');
  let editorComponent = $state<ReturnType<typeof loadEditor> | null>(null);
  $effect(() => {
    if (
      tab?.data?.encoding === 'utf8' &&
      tab.mode !== 'preview' &&
      !editorComponent
    )
      editorComponent = loadEditor();
  });
  let markdownComponent = $state<ReturnType<typeof loadMarkdown> | null>(null);
  function loadMarkdown() {
    return import('./Markdown.svelte');
  }
  $effect(() => {
    if (
      tab &&
      (tab.mode === 'preview' || tab.mode === 'split') &&
      !markdownComponent
    )
      markdownComponent = loadMarkdown();
  });
  async function startEdit() {
    const target = tab;
    if (!target || target.fileOperation) return;
    if (
      tab.data?.readOnlyRecommended &&
      (await ask(
        'Large text file',
        'Editing a file over 1 MiB may use more memory. Continue?',
        ['Edit', 'Cancel'],
      )) !== 'Edit'
    )
      return;
    if (tab !== target || target.fileOperation) return;
    target.editing = true;
    target.mode = 'edit';
  }
  async function closeComparison() {
    const previous = comparisonFor;
    comparisonFor = null;
    await tick();
    if (tab !== previous) return;
    const target =
      workspace?.querySelector<HTMLElement>(
        '.cm-content[contenteditable="true"]',
      ) ??
      workspace?.querySelector<HTMLElement>(
        '.file-conflict-banner button:not(:disabled)',
      ) ??
      workspace?.querySelector<HTMLElement>(
        '.file-toolbar button:not(:disabled)',
      );
    target?.focus({ preventScroll: true });
  }
  function compareDisk() {
    if (!tab || tab.fileOperation) return;
    comparisonFor = tab;
    comparisonPath = tab.path;
    conflictComponent ??= loadConflictReview();
  }
</script>

<div class="file-workspace" bind:this={workspace}>
  <div class="file-tabs">
    {#each editor.tabs as t (t.path)}<div
        class:chosen={editor.active === t.path}
      >
        <button onclick={() => openFile(t.path)} title={t.path}
          >{t.path.split('/').at(-1)}{t.dirty ? ' ●' : ''}</button
        ><button
          aria-label={`Close ${t.path}`}
          disabled={!!t.fileOperation}
          onclick={() => closeTab(t.path)}
          ><Icon name="close" size={13} /></button
        >
      </div>{/each}
  </div>
  {#if editor.error}<div class="banner error">
      {editor.error}<button
        onclick={() => (editor.error = '')}
        aria-label="Dismiss file error"><Icon name="close" size={14} /></button
      >
    </div>{/if}
  {#if editor.loading}<p class="muted padded">Loading file…</p>{/if}
  {#if tab?.data}
    <div class="file-toolbar">
      <span class="mono truncate" title={tab.path}>{tab.path}</span><span
        class="muted">{tab.editing ? 'Editing' : 'View'}</span
      >
      {#if /\.(md|markdown)$/i.test(tab.path)}<div class="segmented">
          {#each ['edit', 'preview', 'split'] as mode}<button
              class:chosen={tab.mode === mode}
              onclick={() => {
                tab.mode = mode as 'edit' | 'preview' | 'split';
              }}
              >{mode === 'edit'
                ? 'Source'
                : mode === 'preview'
                  ? 'Preview'
                  : 'Split'}</button
            >{/each}
        </div>{/if}
      {#if tab.data.encoding === 'utf8'}{#if tab.editing}<button
            class="primary"
            disabled={!tab.dirty ||
              tab.saving ||
              tab.reloading ||
              !!tab.fileOperation}
            onclick={() => saveTab()}>Save <kbd>⌘S</kbd></button
          >{:else}<button disabled={!!tab.fileOperation} onclick={startEdit}
            >Edit</button
          >{/if}{/if}
      <button
        title="Show containing folder"
        aria-label="Show containing folder"
        onclick={() =>
          api.reveal(tab.path).catch((e) => (editor.error = String(e)))}
        ><Icon name="folder-open" size={16} /></button
      >
    </div>
    {#if tab.fileOperation}<div class="banner" role="status">
        {tab.fileOperation === 'rename'
          ? 'Renaming this file…'
          : 'Moving this file to Trash…'} Editing is paused until the action finishes.
      </div>{/if}
    {#if tab.editing && activeTask}<div class="banner">
        An agent is working and may modify this file. Unsaved edits stay in your
        buffer.
      </div>{/if}
    {#if tab.conflict && comparisonFor !== tab}<div
        class="banner warning file-conflict-banner"
      >
        <span>{tab.conflict}</span><button
          disabled={tab.saving || tab.reloading || !!tab.fileOperation}
          onclick={compareDisk}>Compare</button
        ><button
          disabled={tab.saving || tab.reloading || !!tab.fileOperation}
          onclick={() => reloadTab(tab)}>Reload disk</button
        >
      </div>{/if}
    {#if comparisonFor === tab && conflictComponent}
      {#await conflictComponent}<p class="muted padded">
          Loading comparison…
        </p>{:then module}
        {#key comparisonFor}<module.default
            {tab}
            onclose={() => void closeComparison()}
          />{/key}
      {:catch error}<div class="banner error">
          Could not open comparison: {String(error)}<button
            onclick={() => void closeComparison()}>Keep editing</button
          >
        </div>{/await}
    {/if}
    {#if tab.data.encoding !== 'utf8'}<div class="empty">
        <h2>
          {tab.data.encoding === 'binary'
            ? 'Binary file'
            : 'File too large to preview'}
        </h2>
        <p>
          {(tab.data.sizeBytes / 1024 / 1024).toFixed(2)} MiB · UTF-8 files up to
          5 MiB can be opened.
        </p>
        <button onclick={() => api.reveal(tab.path)}>Show in folder</button>
      </div>
    {:else}<div
        class="file-content"
        class:split={tab.mode === 'split'}
        hidden={comparisonFor === tab}
      >
        {#if tab.mode !== 'preview' && editorComponent}<div class="editor-wrap">
            {#await editorComponent}<p class="muted padded">
                Loading editor…
              </p>{:then module}<module.default
                {tab}
                onchange={editContent}
                {oncontext}
              />{:catch error}<p class="error">{String(error)}</p>{/await}
          </div>{/if}
        {#if tab.mode !== 'edit' && markdownComponent}{#await markdownComponent}<p
              class="muted"
            >
              Loading preview…
            </p>{:then module}<module.default
              text={tab.content ?? ''}
              path={tab.path}
              onopen={openFile}
            />{/await}{/if}
      </div>{/if}
    <footer class="file-status">
      UTF-8 · {tab.data.newline.toUpperCase()} · {(
        tab.data.sizeBytes / 1024
      ).toFixed(1)} KiB
      <span>{tab.dirty ? 'Unsaved changes' : 'Saved on disk'}</span>
    </footer>
  {:else if !editor.loading}<div class="empty">
      <div class="empty-symbol"><Icon name="code" size={42} /></div>
      <h2>A closer look at your code</h2>
      <p>
        Choose a file in the project tree or press <kbd>⌘P</kbd>.<br />Files
        open in read-only mode.
      </p>
    </div>{/if}
</div>
