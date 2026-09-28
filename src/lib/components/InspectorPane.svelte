<script lang="ts">
  // Changes inspector beside the conversation. The diff controls, file list, and
  // diff view are snippets from App so the review workspace can share them.
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { GitSnapshot } from '../types';
  let {
    changeCount,
    diffSource,
    active,
    project,
    git,
    gitBusy,
    hasTask,
    planReady,
    selectedPath,
    controls,
    list,
    detail,
    onclose,
    onreadplan,
    onrefresh,
  }: {
    changeCount: number;
    diffSource: string;
    active: boolean;
    project: boolean;
    git: GitSnapshot | null;
    gitBusy: boolean;
    hasTask: boolean;
    planReady: boolean;
    selectedPath: string;
    controls: Snippet;
    list: Snippet;
    detail: Snippet;
    onclose: () => void;
    onreadplan: () => void;
    onrefresh: () => void;
  } = $props();
</script>

<aside class="inspector" id="changes-inspector" aria-label="Changes inspector">
  <div class="pane-heading">
    <span>Changes <b>{changeCount}</b></span>
    <div>
      <span class="live-label" class:live={diffSource === 'task' && active}
        >{diffSource === 'task' && active ? '● Live' : ''}</span
      ><button aria-label="Close inspector" onclick={onclose}
        ><Icon name="close" size={15} /></button
      >
    </div>
  </div>
  {@render controls()}{@render list()}{#if selectedPath}{@render detail()}{:else}<div
      class="inspector-empty"
    >
      <span class="inspector-empty-icon" aria-hidden="true"
        ><Icon name="changes" size={23} /></span
      >
      {#if !project}
        <h3>A place to review your changes</h3>
        <p>
          Open a project to inspect changed files alongside your conversation.
        </p>
      {:else if diffSource === 'repository'}
        {#if gitBusy}
          <h3>Checking repository…</h3>
          <p>Reading the current file changes from Git.</p>
        {:else if !git?.available || git.error}
          <h3>Git changes unavailable</h3>
          <p>
            {git?.error ||
              'This folder has no Git repository. Task changes can still appear when Codex reports them.'}
          </p>
        {:else}
          <h3>No changes in this snapshot</h3>
          <p>
            Git reported no changed files at the last refresh. Refresh to
            include edits made outside Bindaas.
          </p>
        {/if}
      {:else if active}
        <h3>Waiting for file changes</h3>
        <p>
          Codex is working. Files appear here as it reports edits; reading and
          planning may not change any files.
        </p>
      {:else if hasTask}
        <h3>No file changes reported</h3>
        <p>
          This task has no reported file changes in the loaded history.{git?.available
            ? ' Switch to Repository to inspect the working tree.'
            : ''}
        </p>
      {:else}
        <h3>No task selected</h3>
        <p>
          Start a conversation or open a previous task to inspect the file
          changes Codex reports.
        </p>
      {/if}
      <div class="inspector-empty-actions">
        {#if planReady}
          <button onclick={onreadplan}>Read proposed plan →</button>
        {/if}
        {#if project && diffSource === 'repository'}
          <button disabled={gitBusy} onclick={onrefresh}
            >{gitBusy ? 'Refreshing…' : 'Refresh changes'}</button
          >
        {/if}
      </div>
    </div>{/if}
</aside>
