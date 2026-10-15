<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import type { Connection } from '../types';
  import {
    accountUsage,
    invalidateAccountUsage,
    refreshAccountUsage,
  } from '../account-usage.svelte';
  import { remaining, usageAnalysis } from '../usage';
  import { windowLabel } from '../session';
  let {
    connection,
    visible,
    onoverview,
  }: {
    connection: Connection | undefined;
    visible: boolean;
    onoverview: () => void;
  } = $props();
  const value = $derived(accountUsage.value);
  const stale = $derived(
    accountUsage.stale ||
      connection?.type !== 'ready' ||
      (value?.generation ?? 0) < (connection?.generation ?? 0),
  );
  $effect(() => {
    if (connection?.type === 'ready') {
      const generation = connection.generation;
      void generation;
      void refreshAccountUsage();
    }
  });
  onMount(() => {
    let disposed = false;
    const cleanups: UnlistenFn[] = [];
    const target = {
      target: { kind: 'WebviewWindow', label: getCurrentWindow().label },
    } as const;
    let queued = false;
    let again = false;
    async function refresh() {
      if (connection?.type !== 'ready' || disposed) return;
      if (queued) {
        again = true;
        return;
      }
      queued = true;
      // A notification arriving during an older read must get a fresh read.
      if (accountUsage.loading) await refreshAccountUsage();
      do {
        again = false;
        await refreshAccountUsage();
      } while (again && !disposed && connection?.type === 'ready');
      queued = false;
    }
    void Promise.allSettled([
      listen<any>(
        'agent://rate-limits-changed',
        ({ payload }) => {
          if (
            (payload.harness ?? 'codex') !== 'codex' ||
            payload.generation < (connection?.generation ?? 0)
          )
            return;
          accountUsage.stale = true;
          void refresh();
        },
        target,
      ),
      listen<any>(
        'agent://auth-updated',
        ({ payload }) => {
          if (
            (payload.harness ?? 'codex') !== 'codex' ||
            payload.generation < (connection?.generation ?? 0)
          )
            return;
          invalidateAccountUsage();
          void refreshAccountUsage().then(() => {
            if (!disposed) void refresh();
          });
        },
        target,
      ),
    ]).then((results) => {
      for (const result of results)
        if (result.status === 'fulfilled') {
          if (disposed) result.value();
          else cleanups.push(result.value);
        } else accountUsage.error = String(result.reason);
    });
    window.addEventListener('focus', refresh);
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      window.removeEventListener('focus', refresh);
    };
  });
</script>

{#if visible}
  <section class="usage-bar" aria-label="Account usage remaining">
    <button class="usage-link" onclick={onoverview}
      >Codex {value?.account?.planType ?? ''}
      <span>Usage analysis ↗</span></button
    >
    {#each value?.limits?.buckets ?? [] as bucket}
      {#each ['primary', 'secondary'] as slot}
        {@const window = bucket[slot as 'primary' | 'secondary']}
        {#if window}
          {@const left = remaining(window)}
          {@const analysis = usageAnalysis(
            window,
            value?.history ?? [],
            `${bucket.id ?? bucket.name ?? 'default'}:${slot}`,
            value?.observedAt ?? Date.now() / 1000,
          )}
          {@const forecast =
            !stale && value?.limits?.ordinaryUsageAllowed !== false
              ? analysis.forecast
              : null}
          {@const forecastStatus =
            value?.limits?.ordinaryUsageAllowed === false
              ? 'Included usage unavailable'
              : stale
                ? 'Last reported · refresh to update'
                : forecast
                  ? `${forecast.basis === 'current-period' ? 'Provisional · ' : ''}${forecast.status}`
                  : 'Forecast learning'}
          <div
            class="usage-gauge"
            title={`${bucket.name ?? 'Codex'} · ${window.resetsAt ? `Resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : 'Reset not reported'} · ${forecastStatus}`}
          >
            <div class="gauge-label">
              <span
                >{bucket.id && bucket.id !== 'codex'
                  ? `${bucket.name ?? bucket.id} · `
                  : ''}{windowLabel(window.windowDurationMins)}</span
              ><strong
                >{left === null
                  ? 'Not reported'
                  : `${left.toFixed(0)}% remaining`}</strong
              >
            </div>
            {#if left !== null}<div
                class="gauge-track"
                role="meter"
                aria-label={`${windowLabel(window.windowDurationMins)} remaining`}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={left}
                aria-valuetext={`${left.toFixed(0)}% remaining. ${forecastStatus}`}
              >
                <div
                  class="gauge-fill"
                  style:width={`${left}%`}
                  style:background={forecast
                    ? `linear-gradient(90deg, hsl(${Math.max(0, forecast.hue - 18)} 60% 45%), hsl(${Math.min(140, forecast.hue + 18)} 65% 62%))`
                    : 'var(--muted)'}
                ></div>
              </div>{/if}
            <span class="gauge-status"
              >{stale
                ? 'Last reported · refresh to update'
                : forecastStatus}</span
            >
          </div>
        {/if}
      {/each}
    {/each}
    {#if value?.limits?.ordinaryUsageAllowed === false}<span
        >Included usage unavailable</span
      >{/if}
    {#if accountUsage.error || value?.limitsError || value?.accountError}<span
        class="usage-message"
        >{accountUsage.error || value?.limitsError || value?.accountError}</span
      >
    {:else if !value?.limits?.buckets.length}<span class="usage-message"
        >{accountUsage.loading ? 'Reading usage…' : 'Usage not available'}</span
      >{/if}
    <button
      disabled={accountUsage.loading}
      onclick={refreshAccountUsage}
      aria-label="Refresh account usage">↻</button
    >
  </section>
{/if}

<style>
  .usage-bar {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px 24px;
    padding: 10px 22px;
    border-top: 1px solid var(--border);
    background: var(--panel);
    font-size: var(--fs-xs);
  }
  .usage-link {
    text-align: left;
    text-transform: capitalize;
    font-weight: 600;
  }
  .usage-link span {
    display: block;
    color: var(--muted);
    font-weight: 400;
    text-transform: none;
    margin-top: 4px;
  }
  .usage-gauge {
    flex: 1;
    min-width: 180px;
    max-width: 360px;
  }
  .gauge-label {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .gauge-track {
    height: 6px;
    background: var(--border);
    border-radius: 99px;
    overflow: hidden;
    margin: 6px 0;
  }
  .gauge-fill {
    height: 100%;
    border-radius: inherit;
  }
  .gauge-status,
  .usage-message {
    color: var(--muted);
  }
  .usage-message {
    flex: 1;
  }
</style>
