<script lang="ts">
  import { drop } from '../motion';
  import { api } from '../api';
  import QuestionCard from './QuestionCard.svelte';
  import type { Approval } from '../types';
  let {
    approval,
    onresolved,
  }: { approval: Approval; onresolved: (id: string) => void } = $props();
  let busy = $state(false);
  let error = $state('');
  let answers = $state<Record<string, string>>({});
  function label(decision: unknown) {
    if (typeof decision === 'string')
      return (
        (
          {
            accept: 'Allow once',
            acceptForSession: 'Allow for session',
            decline: 'Decline',
            cancel: 'Cancel task',
          } as Record<string, string>
        )[decision] ?? decision
      );
    return JSON.stringify(decision);
  }
  async function respond(decision: unknown) {
    busy = true;
    error = '';
    try {
      await api.respond(
        approval.generation,
        approval.requestId,
        decision,
        approval.kind === 'userInput' ? answers : null,
        approval.threadId,
      );
      onresolved(approval.requestId);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if approval.kind === 'userInput'}<QuestionCard
    {approval}
    {onresolved}
  />{:else}
  <section
    class="approval"
    aria-label="Permission required"
    in:drop|global={{ from: 1 }}
  >
    <div class="eyebrow">
      ◇ {approval.kind === 'userInput'
        ? 'Input requested'
        : approval.network
          ? 'Network access requested'
          : 'Permission required'}
    </div>
    {#if approval.network}<h3>
        {approval.network.host} · {approval.network.protocol}{approval.network
          .port
          ? `:${approval.network.port}`
          : ''}
      </h3>{/if}
    {#if approval.command}<pre
        class="approval-command">{approval.command}</pre>{/if}
    {#if approval.cwd}<p class="mono muted">{approval.cwd}</p>{/if}
    {#if approval.reason}<p>{approval.reason}</p>{/if}
    {#if approval.grantRoot}<p>
        Requested write root: <code>{approval.grantRoot}</code>
      </p>{/if}
    {#if approval.permissions}<pre>{JSON.stringify(
          approval.permissions,
          null,
          2,
        )}</pre>{/if}
    {#if approval.kind === 'fileChange'}<p>
        Review the proposed files and diff in the activity timeline and Changes
        inspector.
      </p>{/if}
    {#if approval.questions}{#each approval.questions as question}<label
          class="question"
          >{question.question}<input
            value={answers[question.id] ?? ''}
            oninput={(e) => (answers[question.id] = e.currentTarget.value)}
            list={`answers-${question.id}`}
          /><datalist id={`answers-${question.id}`}
            >{#each question.options ?? [] as option}<option
                value={option.label}>{option.description}</option
              >{/each}</datalist
          ></label
        >{/each}{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="approval-actions">
      {#each approval.decisions as decision}<button
          disabled={busy}
          class:primary={decision === 'accept'}
          onclick={() => respond(decision)}>{label(decision)}</button
        >{/each}{#if approval.kind === 'userInput'}<button
          class="primary"
          disabled={busy}
          onclick={() => respond(null)}>Submit answers</button
        >{/if}
    </div>
  </section>
{/if}
