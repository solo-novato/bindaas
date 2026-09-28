<script lang="ts">
  // One-row task header: live state, conversation title, task details, pane controls.
  import type { Snippet } from 'svelte';
  import { rise } from '../motion';
  import { permissionLabel } from '../session';
  import { duration } from '../timeline';
  import type { ThreadSettings, TimelineItem, Turn } from '../types';
  let {
    turn,
    starting,
    active,
    thinking,
    awaitingDecision,
    latestPlan,
    threadId,
    title,
    agentBadge,
    elapsedMs,
    taskPrompt,
    taskSettings,
    leading,
    actions,
  }: {
    turn: Turn | null;
    starting: boolean;
    active: boolean;
    thinking: boolean;
    awaitingDecision: boolean;
    latestPlan: TimelineItem | undefined;
    threadId: string | null;
    title: string;
    agentBadge: string | null;
    elapsedMs: number;
    taskPrompt: string;
    taskSettings: ThreadSettings | null;
    leading?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<section
  class="task-header"
  class:plan-ready={!active &&
    turn?.status === 'completed' &&
    latestPlan?.status === 'completed'}
  data-status={awaitingDecision
    ? 'waitingForApproval'
    : starting
      ? 'inProgress'
      : turn?.status}
>
  {@render leading?.()}
  <div class="task-heading">
    <span class="task-state"
      >{awaitingDecision
        ? 'Waiting for you'
        : turn?.status === 'inProgress' || starting
          ? thinking
            ? 'Thinking'
            : 'In progress'
          : turn?.status === 'connectionLost'
            ? 'Connection lost'
            : turn?.status === 'completed' && latestPlan?.status === 'completed'
              ? latestPlan.truncated
                ? 'Plan received'
                : 'Plan ready'
              : turn?.status === 'completed'
                ? 'Completed'
                : turn?.status === 'interrupted'
                  ? 'Interrupted'
                  : turn?.status === 'failed'
                    ? 'Failed'
                    : turn?.status}</span
    >
    {#key threadId}<h2 {title} in:rise={{ y: 6 }}>
        {title}
      </h2>{/key}
    {#if agentBadge}<span class="agent-badge">{agentBadge}</span>{/if}
    <details class="task-details">
      <summary
        ><span>{active ? duration(elapsedMs) : duration(turn?.durationMs)}</span
        >Task details</summary
      >
      <div class="task-details-panel">
        <p class="task-original-prompt">{taskPrompt}</p>
        <div class="task-meta">
          <span
            >{active ? duration(elapsedMs) : duration(turn?.durationMs)}</span
          >{#if taskSettings?.mode}<span
              >{taskSettings.mode === 'plan' ? 'Plan mode' : 'Code mode'}</span
            >{/if}{#if taskSettings?.model}<span>{taskSettings.model}</span
            >{/if}{#if taskSettings?.effort}<span>{taskSettings.effort}</span
            >{/if}{#if taskSettings?.sandbox}<span
              title={JSON.stringify(taskSettings.sandbox)}
              >{permissionLabel(taskSettings.sandbox)}</span
            >{/if}{#if taskSettings?.approvalPolicy}<span
              title="Approval policy"
              >Approvals: {typeof taskSettings.approvalPolicy === 'string'
                ? taskSettings.approvalPolicy
                : 'custom'}</span
            >{/if}
        </div>
      </div>
    </details>
  </div>
  <div class="surface-actions">{@render actions?.()}</div>
</section>
