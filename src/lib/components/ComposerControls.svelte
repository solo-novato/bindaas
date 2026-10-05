<script lang="ts" module>
  import type { CollaborationMode, Harness, Model } from '../types';
  export type ComposerState = {
    agentLabel: string;
    harness: Harness;
    multiAgent: boolean;
    navigationBusy: boolean;
    attaching: boolean;
    canAttach: boolean;
    canAddContext: boolean;
    canChangePermissions: boolean;
    permissionsLabel: string;
    mode: CollaborationMode | null;
    settingsLocked: boolean;
    models: Model[];
    model: string;
    effort: string;
    selectedModel: Model | undefined;
    reasoningEffort: boolean;
    hasThread: boolean;
    canConnect: boolean;
    active: boolean;
    canSteer: boolean;
    canQueue: boolean;
    queueSending: boolean;
    canSend: boolean;
  };
</script>

<script lang="ts">
  // The composer's control row: context, agent, permissions, mode, model, send.
  import Icon from './Icon.svelte';
  import { slidingIndicator } from '../motion';
  let {
    c,
    onattach,
    onaddcontext,
    onharness,
    onpermissions,
    onmode,
    onmodel,
    oneffort,
    onconnect,
    onqueue,
    onstop,
    onsend,
  }: {
    c: ComposerState;
    onattach: () => void;
    onaddcontext: (trigger: HTMLElement) => void;
    onharness: (harness: Harness) => void;
    onpermissions: () => void;
    onmode: (mode: CollaborationMode) => void;
    onmodel: (model: string) => void;
    oneffort: (effort: string) => void;
    onconnect: () => void;
    onqueue: () => void;
    onstop: () => void;
    onsend: () => void;
  } = $props();
</script>

<div class="composer-controls">
  <div>
    <button class="context-button" disabled={!c.canAttach} onclick={onattach}
      ><Icon name="paperclip" size={14} />{c.attaching
        ? 'Attaching…'
        : 'Attach'}</button
    >
    <button
      class="context-button"
      aria-label="Add file context for current editor"
      tabindex="0"
      disabled={!c.canAddContext}
      onclick={(event) => onaddcontext(event.currentTarget)}
      ><Icon name="plus" size={14} /> Context</button
    >
  </div>
  <div class="model-controls">
    {#if c.multiAgent}<select
        class="agent-picker"
        aria-label="Agent"
        value={c.harness}
        disabled={c.navigationBusy}
        onchange={(e) => onharness(e.currentTarget.value as Harness)}
      >
        <option value="codex">Codex</option><option value="claude"
          >Claude</option
        >
      </select>{/if}
    <button
      aria-label="Permissions"
      title="Conversation permissions"
      disabled={!c.canChangePermissions}
      onclick={onpermissions}
      ><Icon name="shield" size={14} />
      {c.permissionsLabel}</button
    >
    <div
      class="segmented glide mode-toggle"
      role="group"
      aria-label={`${c.agentLabel} mode`}
      use:slidingIndicator={'.chosen'}
    >
      <button
        class:chosen={c.mode === 'default'}
        aria-pressed={c.mode === 'default'}
        disabled={c.settingsLocked}
        onclick={() => onmode('default')}>Code</button
      >
      <button
        class:chosen={c.mode === 'plan'}
        aria-pressed={c.mode === 'plan'}
        disabled={c.settingsLocked}
        onclick={() => onmode('plan')}>Plan</button
      >
    </div>
    {#if c.models.length}<select
        aria-label="Model"
        value={c.model}
        disabled={c.settingsLocked}
        onchange={(e) => onmodel(e.currentTarget.value)}
        ><option value="" disabled={c.hasThread}>{c.agentLabel} default</option>
        {#if c.model && !c.selectedModel}<option value={c.model}
            >{c.model}</option
          >{/if}
        {#each c.models as m}<option value={m.model}>{m.displayName}</option
          >{/each}</select
      >{#if c.reasoningEffort}<select
          aria-label="Reasoning effort"
          value={c.effort}
          disabled={c.settingsLocked}
          onchange={(e) => oneffort(e.currentTarget.value)}
          ><option value="" disabled={c.hasThread}
            >{c.agentLabel} default</option
          >
          {#if c.effort && !c.selectedModel?.supportedReasoningEfforts.some((e) => e.reasoningEffort === c.effort)}<option
              value={c.effort}>{c.effort}</option
            >{/if}
          {#each c.selectedModel?.supportedReasoningEfforts ?? [] as e}<option
              value={e.reasoningEffort}>{e.reasoningEffort}</option
            >{/each}</select
        >{/if}{:else}<button
        class="model-trigger"
        title={`Model: ${c.model || `${c.agentLabel} default`}`}
        disabled={!c.canConnect}
        onclick={onconnect}
        >Model: {c.model || `${c.agentLabel} default`} ⌄</button
      >{/if}
  </div>
  <div class="send-controls">
    {#if c.active && c.canSteer}<button
        class="queue-next-button"
        aria-label="Queue for next turn"
        disabled={!c.canQueue}
        title="Wait until the current turn finishes"
        onclick={onqueue}>Queue next</button
      >{/if}{#if c.active}<button
        class="stop"
        title="Stop the running task"
        onclick={onstop}
        ><span class="stop-glyph" aria-hidden="true"></span>Stop</button
      >{/if}<button
      class="primary send-button"
      aria-label="Send"
      title={c.active && c.harness === 'claude'
        ? 'Queue a follow-up for the next turn'
        : c.active
          ? 'Send to the running task; Codex picks it up during this turn using its current settings'
          : 'Send message (⌘↵)'}
      disabled={!c.canSend}
      onclick={onsend}
      >{c.queueSending
        ? 'Sending…'
        : c.active && c.harness === 'claude'
          ? 'Queue next'
          : 'Send'}
      <Icon name="arrow-up" size={15} /></button
    >
  </div>
</div>
