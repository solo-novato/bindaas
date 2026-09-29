<script lang="ts">
  // Empty-conversation screen: open a project, or start from a suggestion.
  import Icon, { type IconName } from './Icon.svelte';
  import { spotlight } from '../motion';
  let {
    projectOpen,
    agentLabel,
    busy,
    canResume,
    noAgent = false,
    onopenproject,
    onsuggest,
    onresume,
    onsetup,
  }: {
    projectOpen: boolean;
    agentLabel: string;
    busy: boolean;
    canResume: boolean;
    /** Neither the Codex CLI nor Claude Code is set up yet. */
    noAgent?: boolean;
    onopenproject: () => void;
    onsuggest: (title: string) => void;
    onresume: () => void;
    onsetup?: () => void;
  } = $props();
  const agent = $derived(noAgent ? 'your agent' : agentLabel);
  const taskSuggestions: {
    title: string;
    description: string;
    icon: IconName;
  }[] = [
    {
      title: 'Explain how this project works',
      description: 'Get your bearings in the codebase',
      icon: 'search',
    },
    {
      title: 'Find and fix a bug',
      description: 'Trace a problem to its source',
      icon: 'code',
    },
    {
      title: 'Add a new feature',
      description: 'Bring your next idea to life',
      icon: 'plus',
    },
  ];
</script>

<section class="welcome" class:project-ready={projectOpen}>
  <div class="welcome-icon" aria-hidden="true">
    <Icon name="workbench" size={26} />
  </div>
  <h1>What are we building?</h1>
  {#if noAgent}<p class="agent-missing" role="status">
      No coding agent is set up yet. Install the Codex CLI or Claude Code to
      start. <button class="text-link" onclick={onsetup}>Set up an agent</button
      >
    </p>{/if}
  <p>
    {projectOpen
      ? `Describe a task for ${agent}, or start from one of these.`
      : `Open a folder and ${agent} will work inside it with you.`}
  </p>
  {#if !projectOpen}<button
      class="primary large"
      aria-label="Open a project"
      disabled={busy}
      onclick={onopenproject}
      ><Icon name="folder" size={17} /> Open a project
      <kbd>⌘ O</kbd></button
    >{:else}<div class="suggestions" use:spotlight>
      {#each taskSuggestions as suggestion, n}<button
          data-spotlight
          style={`--i:${n}`}
          aria-label={suggestion.title}
          onclick={() => onsuggest(suggestion.title)}
          ><span class="suggestion-icon"
            ><Icon name={suggestion.icon} size={17} /></span
          ><span class="suggestion-copy"
            ><strong>{suggestion.title}</strong><small
              >{suggestion.description}</small
            ></span
          ><span class="suggestion-arrow"
            ><Icon name="arrow-right" size={15} /></span
          ></button
        >{/each}
    </div>
    {#if canResume}<button class="resume-button" onclick={onresume}
        >Resume last thread →</button
      >{/if}{/if}
  {#if !noAgent}<div class="quiet-note">
      <span class="quiet-dot" aria-hidden="true"></span>
      {agentLabel} starts on your first message and sleeps when idle.
    </div>{/if}
</section>
