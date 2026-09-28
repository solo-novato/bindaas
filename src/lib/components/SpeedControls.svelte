<script lang="ts">
  import { api } from '../api';
  import type { Connection, SpeedResult, SpeedTarget } from '../types';
  let {
    selected,
    running,
    connection,
    reportedTier,
    disabled = false,
    onbusy,
    onupdated,
  }: {
    selected: SpeedTarget | null;
    running: SpeedTarget[];
    connection: Connection;
    reportedTier?: string | null;
    disabled?: boolean;
    onbusy: (busy: boolean) => void;
    onupdated: () => void;
  } = $props();
  let fast = $state(false);
  let busy = $state(false);
  let error = $state('');
  let results = $state<(SpeedResult & { title: string })[]>([]);
  let requested = $state('');
  const unavailable = $derived(disabled || busy || connection.type !== 'ready');
  const tierLabel = $derived(
    reportedTier === 'fast' || reportedTier === 'priority'
      ? 'Fast'
      : reportedTier === 'default'
        ? 'Standard'
        : reportedTier || 'Codex default / not reported',
  );
  async function apply(targets: SpeedTarget[]) {
    if (unavailable || !targets.length) return;
    const snapshot = targets.map((target) => ({ ...target }));
    const generation = connection.generation ?? 0;
    busy = true;
    onbusy(true);
    error = '';
    results = [];
    requested = fast ? 'Fast' : 'Standard';
    try {
      const value = await api.setSpeed(generation, snapshot, fast);
      if (value.generation !== connection.generation) {
        error =
          'Codex reconnected during the update. Refresh status to check the current settings.';
        return;
      }
      results = value.results.map((result) => ({
        ...result,
        title:
          snapshot.find((target) => target.threadId === result.threadId)
            ?.title || 'Conversation',
      }));
      onupdated();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      onbusy(false);
    }
  }
</script>

<section class="speed-controls" aria-label="Speed controls" aria-busy={busy}>
  <div class="row">
    <h3>Speed</h3>
    <span class="muted">Reported: {tierLabel}</span>
  </div>
  <p class="muted small">
    Fast uses more credits when available. Changes apply to upcoming model
    requests and future messages in the chosen conversations. Requests already
    in flight and child tasks may keep their current speed.
  </p>
  <div class="speed-actions">
    <label
      >Processing speed
      <select
        aria-label="Processing speed"
        bind:value={fast}
        disabled={unavailable}
      >
        <option value={false}>Standard</option>
        <option value={true}>Fast</option>
      </select>
    </label>
    <button
      disabled={unavailable || !selected}
      onclick={() => selected && apply([selected])}
    >
      Apply to conversation
    </button>
    <button
      class="primary"
      disabled={unavailable || !running.length}
      onclick={() => apply(running)}
    >
      Apply to all {running.length} running tasks
    </button>
  </div>
  {#if busy}<p role="status">Updating speed in Codex…</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if results.length}
    <div class="speed-results" role="status" aria-live="polite">
      <strong>{requested} update results</strong>
      <ul>
        {#each results as result}
          <li>
            <strong>{result.title}</strong>
            {#if result.error}<p class="error">{result.error}</p>
            {:else}
              <p>
                {result.future === 'saved'
                  ? 'Saved for future messages.'
                  : 'Future messages could not be updated.'}
                {result.active === 'applied'
                  ? ' Running task updated.'
                  : result.active === 'targetUnavailable'
                    ? ' The original task is no longer available; no running task was changed.'
                    : result.active === 'failed'
                      ? ' Running task could not be updated.'
                      : ' No running task was targeted.'}
              </p>
              {#if result.futureError}<p class="error">
                  {result.futureError}
                </p>{/if}
              {#if result.activeError}<p class="error">
                  {result.activeError}
                </p>{/if}
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .speed-controls {
    padding-bottom: 20px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .speed-controls > .row {
    align-items: baseline;
    margin-bottom: 6px;
  }
  .speed-controls h3 {
    margin: 0;
  }
  .speed-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 10px;
  }
  label {
    display: grid;
    gap: 6px;
    font-size: var(--fs-sm);
  }
  .speed-actions button:not(.primary) {
    border: 1px solid var(--border);
  }
  select {
    min-width: 125px;
  }
  .speed-results {
    margin-top: 16px;
  }
  ul {
    padding-left: 18px;
  }
  li + li {
    margin-top: 12px;
  }
  li p {
    margin: 4px 0;
    font-size: var(--fs-sm);
  }
</style>
