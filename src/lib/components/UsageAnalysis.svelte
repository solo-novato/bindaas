<script lang="ts">
  import type { AccountStatus } from '../types';
  import { usageAnalysis } from '../usage';
  import { windowLabel } from '../session';
  let { account, stale = false }: { account: AccountStatus; stale?: boolean } =
    $props();
  const now = $derived(account.observedAt ?? Date.now() / 1000);
  const percent = (value: number | null) =>
    value === null ? 'Not enough data' : `${value.toFixed(1)}%`;
</script>

{#each account.limits?.buckets ?? [] as bucket}
  {@const slot =
    bucket.secondary &&
    (!bucket.primary ||
      (bucket.secondary.windowDurationMins ?? 0) >=
        (bucket.primary.windowDurationMins ?? 0))
      ? 'secondary'
      : 'primary'}
  {@const window = bucket[slot]}
  {#if window}
    {@const analysis = usageAnalysis(
      window,
      account.history ?? [],
      `${bucket.id ?? bucket.name ?? 'default'}:${slot}`,
      now,
    )}
    <div
      class="usage-analysis"
      aria-label={`${bucket.name ?? 'Codex'} usage analysis`}
    >
      <h4>
        {bucket.name ?? 'Codex'} · {windowLabel(window.windowDurationMins)}
      </h4>
      <div class="usage-stats">
        <div>
          <span>Used this period</span><strong
            >{analysis.left === null
              ? 'Not reported'
              : percent(100 - analysis.left)}</strong
          >
        </div>
        <div>
          <span>Remaining</span><strong>{percent(analysis.left)}</strong>
        </div>
        <div>
          <span>Average per day so far</span><strong
            >{percent(analysis.dailyAverage)}</strong
          >
        </div>
        <div>
          <span>Available per day until reset</span><strong
            >{percent(analysis.dailyBudget)}</strong
          >
        </div>
      </div>
      <p class="muted small">
        Percentages are shares of this limit, not tokens or money. {analysis.daysLeft ===
        null
          ? 'Reset timing unavailable.'
          : `${analysis.daysLeft.toFixed(1)} days until reset.`}
      </p>
      {#if stale}
        <p class="forecast-summary">
          Last reported usage. Refresh status to update the forecast.
        </p>
      {:else if account.limits?.ordinaryUsageAllowed === false}
        <p class="forecast-summary">
          Included usage is unavailable. Forecast paused until Codex reports
          recovery.
        </p>
      {:else if analysis.forecast}
        <div class="forecast-summary">
          <strong
            >{analysis.forecast.basis === 'current-period'
              ? 'Provisional · '
              : ''}{analysis.forecast.status}</strong
          >
          <p>
            Estimated demand before reset: {percent(analysis.forecast.demand)}. {analysis
              .forecast.headroom < 0
              ? `${percent(-analysis.forecast.headroom)} over the remaining allowance.`
              : `${percent(analysis.forecast.headroom)} expected to remain at reset.`}
          </p>
          {#if analysis.forecast.exhaustion}<p>
              May run out around {new Date(
                analysis.forecast.exhaustion * 1000,
              ).toLocaleString()}.
            </p>{/if}
          <p class="muted small">
            {#if analysis.forecast.basis === 'current-period'}
              Based on usage since this limit period began. This initial
              estimate assumes the same pace continues; it has not learned your
              weekday or weekend pattern yet.
            {:else}
              {analysis.forecast.patterned
                ? 'Weekday-aware estimate: each remaining date uses its own weekday history.'
                : 'Using your historical daily average while weekday patterns build.'}
              Based on {analysis.observedDays} past days with usable observations,
              totaling {analysis.observedDayEquivalents.toFixed(1)} days of coverage.
              Partial days contribute in proportion to their observed time.
            {/if}
            Estimates can change with your workload.
          </p>
          <details open>
            <summary>Forecast by day</summary>
            <table aria-label="Forecast by day">
              <thead
                ><tr><th>Date</th><th>Expected usage</th><th>Based on</th></tr
                ></thead
              >
              <tbody>
                {#each analysis.forecast.days as day}
                  <tr>
                    <td
                      >{new Date(day.at * 1000).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}{day.fraction < 0.999 ? ' · partial day' : ''}</td
                    >
                    <td>{percent(day.demand)}</td>
                    <td
                      >{day.source === 'current-period'
                        ? 'Current period’s pace'
                        : day.source === 'history'
                          ? 'Overall average · no observations for this weekday'
                          : `${day.observations} past observations · ${day.covered.toFixed(1)} days covered${day.source === 'blended' ? ' · blended with overall average' : ''}`}</td
                    >
                  </tr>
                {/each}
              </tbody>
              <tfoot
                ><tr
                  ><th>Total until reset</th><td
                    >{percent(analysis.forecast.demand)}</td
                  ><td></td></tr
                ></tfoot
              >
            </table>
            <p class="muted small">
              Remaining hours today and on the reset date are prorated.
              Partial-day evidence assumes the observed pace represents
              unobserved hours.
            </p>
            {#if analysis.forecast.limited && analysis.forecast.basis !== 'current-period'}
              <p class="muted small">
                Some dates have limited weekday coverage. Only those dates blend
                with or fall back to the overall average; other weekdays keep
                their own estimates.
              </p>
            {/if}
          </details>
        </div>
      {:else}
        <div class="forecast-summary">
          <strong>Forecast learning</strong>
          <p>
            {analysis.daysLeft === null
              ? 'A current limit and valid reset time are needed.'
              : 'This limit period has only just started. A provisional estimate appears after an hour, or 10% of a short window.'}
            Historical estimates need roughly 3 days of total observation coverage.
            Each weekday learns independently as its own coverage builds.
          </p>
        </div>
      {/if}
      <details>
        <summary>Daily usage · recent observations</summary>
        {#if analysis.days.length}
          <table aria-label="Observed daily usage">
            <thead
              ><tr><th>Day</th><th>Usage observed</th><th>Day coverage</th></tr
              ></thead
            >
            <tbody
              >{#each analysis.days.slice(-14).reverse() as day}<tr>
                  <td
                    >{new Date(day.at * 1000).toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}</td
                  >
                  <td>{percent(day.used)}</td><td
                    >{Math.min(100, (day.covered / day.seconds) * 100).toFixed(
                      0,
                    )}%{day.at <= now && now < day.at + day.seconds
                      ? ' · today so far'
                      : ''}</td
                  >
                </tr>{/each}</tbody
            >
          </table>
        {:else}<p class="muted">
            Daily usage needs at least two observations in the same limit
            period.
          </p>{/if}
        <p class="muted small">
          Daily amounts are estimated between observations. Missing days are
          unknown, not zero. Gaps across resets and long gaps with usage are
          excluded.
        </p>
      </details>
    </div>
  {/if}
{/each}
{#if account.historyImport}
  <p class="muted small">
    Imported {account.historyImport.observations.toLocaleString()} usage observations
    from {account.historyImport.files} Codex sessions across this profile. {account
      .historyImport.limited
      ? 'Some history could not be scanned within the read limits; this estimate uses partial history.'
      : ''}
  </p>
  {#if account.historyImport.legacyFiles}
    <p class="muted small">
      {account.historyImport.legacyFiles} older sessions predate account IDs and are
      attributed to this account from the Codex profile. No other account was identified
      in this profile’s available session headers.
    </p>
  {/if}
  {#if account.historyImport.unattributedFiles}
    <p class="muted small">
      {account.historyImport.unattributedFiles} older sessions were excluded because
      their account could not be attributed safely.
    </p>
  {/if}
{/if}
<p class="muted small">
  Analysis uses locally saved observations and historical Codex quota snapshots
  for this account and plan across all projects in this Codex profile. These are
  account-wide counters, so overlapping sessions are not added together.
  Historical logs are checked on the first usage read each day. Missing days
  remain unknown; other devices are represented only by changes visible in these
  snapshots.
</p>
{#if account.historyError}<p class="muted small">{account.historyError}</p>{/if}

<style>
  h4 {
    margin: 0 0 14px;
  }
  .usage-analysis + .usage-analysis {
    border-top: 1px solid var(--border);
    margin-top: 20px;
    padding-top: 20px;
  }
  .usage-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  .usage-stats span {
    display: block;
    color: var(--muted);
    font-size: var(--fs-xs);
    margin-bottom: 6px;
  }
  .usage-stats strong {
    font-size: var(--fs-lg);
  }
  .forecast-summary {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin: 16px 0;
    line-height: 1.6;
  }
  .forecast-summary p {
    margin: 8px 0 0;
  }
  .small {
    font-size: var(--fs-xs);
    line-height: 1.6;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: var(--fs-xs);
  }
  th,
  td {
    text-align: left;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
  }
  summary {
    cursor: pointer;
  }
</style>
