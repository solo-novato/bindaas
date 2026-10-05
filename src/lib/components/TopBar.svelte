<script lang="ts">
  // The window's top bar: project, navigation, launcher, status, and tasks.
  // It is also the macOS title-bar drag region (see tauri.conf.json).
  import Icon, { type IconName } from './Icon.svelte';
  import { roll, slidingIndicator } from '../motion';
  import type { GitSnapshot, Project } from '../types';
  type Task = { title: string; error?: string };
  let {
    projectTrigger = $bindable(),
    project,
    git,
    projectMenu,
    view,
    changeCount,
    agentLabel,
    multiAgent,
    status,
    connectionType,
    active,
    awaitingDecision,
    workingTasks,
    attentionTasks,
    taskPing,
    navigationBusy,
    projectChanging = false,
    newTaskDisabled,
    onproject,
    onnavigate,
    onlauncher,
    onstatus,
    ontasks,
    onresume,
    onnewtask,
  }: {
    projectTrigger?: HTMLButtonElement;
    project: Project | null;
    git: GitSnapshot | null;
    projectMenu: boolean;
    view: string;
    changeCount: number;
    agentLabel: string;
    multiAgent: boolean;
    status: string;
    connectionType: string;
    active: boolean;
    awaitingDecision: boolean;
    workingTasks: number;
    attentionTasks: [string, Task][];
    taskPing: number;
    navigationBusy: boolean;
    projectChanging?: boolean;
    newTaskDisabled: boolean;
    onproject: () => void;
    onnavigate: (view: string) => void;
    onlauncher: () => void;
    onstatus: () => void;
    ontasks: () => void;
    onresume: (threadId: string) => void;
    onnewtask: () => void;
  } = $props();
  const navigationIcons: Record<string, IconName> = {
    Chat: 'chat',
    Files: 'files',
    Changes: 'changes',
    Runs: 'history',
    Settings: 'settings',
  };
</script>

<header class="topbar" data-tauri-drag-region="deep">
  <div class="brand-mark" aria-hidden="true">
    <Icon name="workbench" size={20} />
  </div>
  <button
    class="project-button"
    bind:this={projectTrigger}
    aria-haspopup="dialog"
    aria-expanded={projectMenu}
    title={project?.root ?? 'Open a project'}
    disabled={projectChanging}
    onclick={onproject}
    ><strong>{project?.displayName ?? 'Bindaas'}</strong><span
      class="project-subtitle muted"
      >{#if git?.branch}<Icon name="branch" size={12} />{/if}<span
        class="truncate"
        >{project
          ? git?.branch || 'Local project'
          : 'Open a project to begin'}</span
      >
      <Icon name="chevron-down" size={12} /></span
    ></button
  >
  <nav
    aria-label="Primary navigation"
    class="glide"
    use:slidingIndicator={'.active'}
  >
    {#each ['Chat', 'Files', 'Changes', 'Runs', 'Settings'] as tab}<button
        class:active={view === tab}
        aria-current={view === tab ? 'page' : undefined}
        disabled={projectChanging}
        onclick={() => onnavigate(tab)}
        ><span class="nav-icon"
          ><Icon name={navigationIcons[tab]} size={15} /></span
        >{tab}{#if tab === 'Changes' && changeCount}<span class="count"
            >{changeCount}</span
          >{/if}</button
      >{/each}
  </nav>
  <button
    class="launch-trigger"
    aria-label="Jump to anything"
    title="Search actions, tasks, and files (⌘K)"
    disabled={projectChanging}
    onclick={onlauncher}
    ><span aria-hidden="true"><Icon name="search" size={15} /></span><span
      >Jump to…</span
    ><kbd>⌘ K</kbd></button
  >
  <button
    aria-label="Session status"
    title="Session status and usage"
    disabled={!project || projectChanging}
    onclick={onstatus}
    class="agent-status"
    class:ready={connectionType === 'ready' && !active}
    class:working={active}
    class:attention={awaitingDecision}
    class:bad={connectionType === 'failed' || connectionType === 'disconnected'}
    ><i></i><span
      >{#if multiAgent}{agentLabel} ·
      {/if}{status}</span
    ><Icon name="chevron-down" size={12} /></button
  >
  <nav class="task-switcher" aria-label="Other tasks">
    <button
      aria-label="Browse tasks"
      title="Switch between tasks (⌘K)"
      class:has-running={workingTasks > 0}
      disabled={!project || projectChanging}
      onclick={ontasks}
    >
      {#if taskPing}{#key taskPing}<span class="task-ping" aria-hidden="true"
          ></span>{/key}{/if}<Icon name="history" size={14} />Tasks {#if workingTasks}<span
          class="task-running-count"
          ><i aria-hidden="true"></i><span class="roll-window"
            >{#key workingTasks}<span in:roll>{workingTasks}</span>{/key}</span
          ><span class="sr-only"> working</span></span
        >{/if}<Icon name="chevron-down" size={12} />
    </button>
    {#if attentionTasks.length}
      {@const next = attentionTasks[0]}
      <button
        class="task-attention"
        disabled={navigationBusy}
        onclick={() => onresume(next[0])}
        aria-label={`Needs attention: ${next[1].title}${attentionTasks.length > 1 ? ` and ${attentionTasks.length - 1} more` : ''}`}
        title={next[1].error ?? next[1].title}
      >
        <span aria-hidden="true">!</span><span
          >{attentionTasks.length} need attention</span
        >
      </button>
    {/if}
  </nav>
  <button class="new-task" disabled={newTaskDisabled} onclick={onnewtask}
    ><Icon name="plus" size={14} /> New task</button
  >
</header>
