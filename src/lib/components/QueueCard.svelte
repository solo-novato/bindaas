<script lang="ts">
  // A follow-up waiting for the running task, shown above the composer.
  import type { Draft } from '../types';
  let {
    queued,
    queueSending,
    queueError,
    active,
    claude,
    agentLabel,
    navigationBusy,
    hasDraft,
    onsend,
    onedit,
    onremove,
  }: {
    queued: Draft;
    queueSending: boolean;
    queueError: string;
    active: boolean;
    claude: boolean;
    agentLabel: string;
    navigationBusy: boolean;
    hasDraft: boolean;
    onsend: () => void;
    onedit: () => void;
    onremove: () => void;
  } = $props();
</script>

<section class="queue-card" aria-label="Queued message" aria-live="polite">
  <div class="queue-heading">
    <strong
      >{queueSending ? 'Sending into current task…' : 'Queued message'}</strong
    ><span
      >{queued.mode === 'plan'
        ? 'Plan'
        : queued.mode === 'default'
          ? 'Code'
          : `${agentLabel} settings`} · {queueError
        ? 'Paused — choose Send now to retry'
        : active
          ? 'Sends after this task finishes'
          : 'Ready to send'}</span
    >
  </div>
  <div class="queue-content">
    <p>{queued.prompt || 'Attached context'}</p>
    {#each queued.attachments as attachment}<span class="queue-chip"
        >{attachment.name}</span
      >{/each}{#each queued.contexts as context}<span class="queue-chip"
        >{context.label}</span
      >{/each}
  </div>
  {#if queueError}<p class="queue-error" role="alert">
      {queueError}
    </p>{/if}
  <div class="queue-actions">
    <small
      >{active
        ? claude
          ? 'Claude will receive this after the current turn and its background work finish.'
          : 'Send now adds this message to the running task, using its current mode and settings.'
        : 'Ready to send as a follow-up.'}</small
    >
    <button
      class="primary"
      disabled={navigationBusy || queueSending || (active && claude)}
      onclick={onsend}>Send now</button
    >
    <button disabled={navigationBusy || hasDraft} onclick={onedit}>Edit</button>
    <button disabled={queueSending} onclick={onremove}>Remove</button>
  </div>
</section>
