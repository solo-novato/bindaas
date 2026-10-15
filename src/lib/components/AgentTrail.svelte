<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { api } from '../api';
  import { duration, itemKey } from '../timeline';
  import {
    buildTrail,
    historyEvents,
    reconcileTrailHistory,
    trailEvent,
    trailPath,
    TRAIL_LIMIT,
    type TrailEvent,
    type TrailKind,
  } from '../trail';
  import type { TimelineItem } from '../types';
  import Icon, { type IconName } from './Icon.svelte';

  let {
    items,
    currentTurnId,
    runningTurnId,
    projectRoot,
    onopen,
    onreveal,
    onhistory,
  }: {
    items: TimelineItem[];
    currentTurnId?: string | null;
    runningTurnId?: string | null;
    projectRoot?: string;
    onopen: (path: string) => void;
    onreveal: (key: string) => void;
    onhistory: () => void;
  } = $props();
  const icons: Record<TrailKind, IconName> = {
    request: 'chat',
    note: 'workbench',
    plan: 'file',
    search: 'search',
    read: 'files',
    edit: 'changes',
    check: 'check',
    command: 'terminal',
    tool: 'code',
    status: 'history',
  };
  let records = $state<TrailEvent[]>([]);
  let chosenTurn = $state('');
  let selectedKey = $state<string | null>(null);
  let saved = $state(false);
  let savedEvents = $state<TrailEvent[]>([]);
  let nextCursor = $state<string | null>(null);
  let historyBusy = $state(false);
  let historyError = $state('');
  let retryMore = false;
  let historyWarning = $state('');
  let limited = $state(false);
  let evidence = $state<TimelineItem | null>(null);
  let evidenceBusy = $state(false);
  let evidenceError = $state('');
  let evidenceKey = $state('');
  let sourceRequest = 0;
  let historyRequest = 0;
  let disposed = false;
  const seen = new Map<string, TimelineItem>();
  const sourcePages = new Map<string, string | null>();
  let evidenceCache: TimelineItem[] = [];
  let route: HTMLElement;
  let evidenceHeading = $state<HTMLHeadingElement>();
  const selectedTurn = $derived(
    chosenTurn || currentTurnId || items.at(-1)?.turnId || '',
  );
  const threadId = $derived(
    items.find((i) => i.turnId === selectedTurn)?.threadId ??
      items.at(-1)?.threadId ??
      '',
  );
  const requests = $derived([...new Set(records.map((e) => e.turnId))]);
  const shown = $derived(
    (saved
      ? savedEvents
      : records.filter((e) => e.turnId === selectedTurn)
    ).map((e) =>
      e.status === 'running' && e.turnId !== runningTurnId
        ? { ...e, status: 'unknown' as const }
        : e,
    ),
  );
  const moments = $derived(buildTrail(shown));
  const selected = $derived(
    moments.find((m) => m.events.some((e) => e.key === selectedKey)) ?? null,
  );
  const selectedIndex = $derived(selected ? moments.indexOf(selected) : -1);
  const source = $derived(
    selected?.events.find((e) => e.key === evidenceKey) ?? selected?.events[0],
  );
  const liveEvidence = $derived(
    source ? items.find((i) => itemKey(i) === source.key) : undefined,
  );
  const displayedEvidence = $derived(
    saved ? (evidence ?? liveEvidence) : (liveEvidence ?? evidence),
  );
  const parent = $derived(
    source?.parentToolId
      ? (saved ? savedEvents : records).find(
          (e) => e.turnId === source.turnId && e.id === source.parentToolId,
        )
      : null,
  );
  const failures = $derived(moments.filter((m) => m.status === 'failed'));
  const lastMoment = $derived(moments.at(-1));

  onDestroy(() => {
    disposed = true;
    sourceRequest++;
    historyRequest++;
  });
  $effect(() => {
    const live = items;
    const running = runningTurnId;
    untrack(() => {
      const updates = new Map<string, TrailEvent>();
      for (const item of live) {
        const key = itemKey(item);
        if (seen.get(key) === item) continue;
        seen.set(key, item);
        const event = trailEvent(item, running);
        if (event) updates.set(key, event);
      }
      // Prune even when every new item is omitted from the trail (for example,
      // thinking summaries), so old transcript bodies cannot accumulate here.
      const retained = new Set(live.map(itemKey));
      for (const key of seen.keys()) if (!retained.has(key)) seen.delete(key);
      if (!updates.size) return;
      const changed = new Set(updates.keys());
      const merged = records.map((record) => {
        const update = updates.get(record.key);
        updates.delete(record.key);
        return update ?? record;
      });
      merged.push(...updates.values());
      if (merged.length > TRAIL_LIMIT) limited = true;
      records = merged.slice(-TRAIL_LIMIT);
      if (saved) {
        const newer = new Map(live.map((i) => [itemKey(i), i]));
        savedEvents = savedEvents.map((e) => {
          const item = changed.has(e.key) ? newer.get(e.key) : undefined;
          return item ? (trailEvent(item, running) ?? e) : e;
        });
        if (source && changed.has(source.key))
          evidence = newer.get(source.key) ?? evidence;
      }
    });
  });
  function requestName(id: string) {
    const prompt = records.find(
      (e) => e.turnId === id && e.kind === 'request',
    )?.text;
    return prompt
      ? prompt.slice(0, 80)
      : id === currentTurnId
        ? 'Current request'
        : `Request ${requests.indexOf(id) + 1}`;
  }
  function resetHistory() {
    historyRequest++;
    sourceRequest++;
    saved = false;
    savedEvents = [];
    sourcePages.clear();
    evidenceCache = [];
    nextCursor = null;
    historyBusy = false;
    historyError = '';
    retryMore = false;
    historyWarning = '';
    selectedKey = null;
    evidence = null;
    evidenceBusy = false;
    evidenceError = '';
  }
  let previousTurn = untrack(() => selectedTurn);
  $effect(() => {
    if (selectedTurn !== previousTurn) {
      previousTurn = selectedTurn;
      resetHistory();
    }
  });
  async function loadHistory(more = false) {
    if (!threadId || !selectedTurn || historyBusy) return;
    const request = ++historyRequest;
    const cursor = more ? nextCursor : null;
    const before = new Map(items.map((i) => [itemKey(i), i]));
    historyBusy = true;
    historyError = '';
    retryMore = more;
    try {
      const page = await api.items(threadId, selectedTurn, cursor);
      if (disposed || request !== historyRequest) return;
      const events = historyEvents(page.data, before, items, runningTurnId);
      const existing = more ? savedEvents : [];
      const merged = new Map(existing.map((e) => [e.key, e]));
      for (const e of events) merged.set(e.key, e);
      savedEvents = [...merged.values()].slice(0, TRAIL_LIMIT);
      if (!more) {
        sourcePages.clear();
        selectedKey = null;
      }
      for (const event of events)
        if (savedEvents.some((e) => e.key === event.key))
          sourcePages.set(event.key, cursor);
      evidenceCache = reconcileTrailHistory(page.data, before, items);
      nextCursor = page.nextCursor;
      historyWarning = page.warning ?? '';
      if (page.nextCursor && page.nextCursor === cursor) {
        nextCursor = null;
        historyWarning =
          'The agent returned a repeated history cursor. Open History to inspect the retained transcript.';
      }
      saved = true;
    } catch (error) {
      if (!disposed && request === historyRequest) historyError = String(error);
    } finally {
      if (!disposed && request === historyRequest) historyBusy = false;
    }
  }
  async function selectEvent(event: TrailEvent) {
    selectedKey = event.key;
    evidenceKey = event.key;
    evidence = null;
    evidenceError = '';
    evidenceBusy = false;
    void tick().then(() => {
      if (!disposed && route && getComputedStyle(route).display === 'none')
        evidenceHeading?.focus({ preventScroll: true });
    });
    const request = ++sourceRequest;
    const known = saved
      ? evidenceCache.find((i) => itemKey(i) === event.key)
      : items.find((i) => itemKey(i) === event.key);
    if (known) {
      evidence = known;
      return;
    }
    if (!sourcePages.has(event.key)) {
      evidenceError =
        'This source is outside the live transcript window. Load saved activity from the beginning to inspect it.';
      return;
    }
    evidenceBusy = true;
    const before = new Map(items.map((i) => [itemKey(i), i]));
    try {
      const page = await api.items(
        event.threadId,
        event.turnId,
        sourcePages.get(event.key),
      );
      if (disposed || request !== sourceRequest) return;
      evidenceCache = reconcileTrailHistory(page.data, before, items);
      evidence = evidenceCache.find((i) => itemKey(i) === event.key) ?? null;
      if (!evidence)
        evidenceError =
          'The agent no longer returned this source. Refresh saved activity to see the current history.';
    } catch (error) {
      if (!disposed && request === sourceRequest) evidenceError = String(error);
    } finally {
      if (!disposed && request === sourceRequest) evidenceBusy = false;
    }
  }
  async function jumpTo(key: string) {
    const moment = moments.find((m) => m.key === key);
    if (!moment) return;
    await selectEvent(moment.events[0]);
    await tick();
    const button = Array.from(
      route?.querySelectorAll<HTMLButtonElement>('[data-trail-key]') ?? [],
    ).find((b) => b.dataset.trailKey === key);
    button?.scrollIntoView({ block: 'nearest' });
    if (route && getComputedStyle(route).display !== 'none')
      button?.focus({ preventScroll: true });
  }
  async function backToMoments() {
    const key = selected?.key;
    selectedKey = null;
    sourceRequest++;
    await tick();
    Array.from(
      route?.querySelectorAll<HTMLButtonElement>('[data-trail-key]') ?? [],
    )
      .find((b) => b.dataset.trailKey === key)
      ?.focus({ preventScroll: true });
  }
  function statusLabel(status: string) {
    return status === 'running'
      ? 'In progress'
      : status === 'failed'
        ? 'Failed'
        : status === 'completed'
          ? 'Completed'
          : 'Outcome unavailable';
  }
</script>

<section class="agent-trail" aria-label="Agent trail">
  <header class="trail-heading">
    <div class="trail-heading-copy">
      <span class="eyebrow">Follow the work</span>
      <h3>One task. Every turn it took.</h3>
    </div>
    <div class="trail-history-actions">
      {#if saved}<button onclick={resetHistory}
          ><Icon name="refresh" size={13} /> Latest activity</button
        >{/if}
      <button
        disabled={historyBusy || !threadId || !selectedTurn}
        onclick={() => loadHistory()}
        ><Icon name="history" size={14} />{historyBusy
          ? 'Loading…'
          : saved
            ? 'Refresh history'
            : 'From beginning'}</button
      >
    </div>
  </header>
  <div class="trail-context">
    {#if requests.length > 1}<select
        aria-label="Trail request"
        value={chosenTurn}
        onchange={(e) => {
          chosenTurn = e.currentTarget.value;
        }}
      >
        <option value="">Current request</option>
        {#each requests.filter((id) => id !== currentTurnId) as id}<option
            value={id}>{requestName(id)}</option
          >{/each}
      </select>{:else}<span>{saved ? 'Saved activity' : 'Recent activity'}</span
      >{/if}
    <span>{moments.length} {moments.length === 1 ? 'moment' : 'moments'}</span>
    {#if failures.length}<button
        class="trail-failures"
        onclick={() =>
          jumpTo(
            failures[
              (failures.findIndex((m) => m.key === selected?.key) + 1) %
                failures.length
            ].key,
          )}
        >{failures.length}
        {failures.length === 1 ? 'failed action' : 'failed actions'}
        <Icon name="arrow-right" size={12} /></button
      >{/if}
    {#if !saved && lastMoment && runningTurnId === selectedTurn}<button
        class="trail-latest"
        onclick={() => jumpTo(lastMoment.key)}
        >Latest <Icon name="arrow-right" size={12} /></button
      >{/if}
  </div>
  {#if historyError}<div class="trail-notice error" role="alert">
      {historyError}<button onclick={() => loadHistory(retryMore)}
        >Retry history</button
      >
    </div>{/if}
  {#if historyWarning}<p class="trail-notice">{historyWarning}</p>{/if}
  <div class="trail-layout" class:trail-has-selection={!!selected}>
    <div class="trail-route" bind:this={route}>
      {#if !saved}<p class="trail-coverage">
          {limited
            ? 'Earlier moments left the live window.'
            : 'Recent activity · Load saved history with “From beginning”.'}
        </p>{/if}
      <ol class="trail-moments" aria-label="Recorded activity">
        {#each moments as moment, index (moment.key)}
          <li class:trail-turning-point={moment.status === 'failed'}>
            <button
              class="trail-moment"
              data-trail-key={moment.key}
              aria-pressed={selected?.key === moment.key}
              onclick={() => selectEvent(moment.events[0])}
            >
              <span
                class="trail-node"
                data-kind={moment.kind}
                data-status={moment.status}
                ><Icon
                  name={moment.status === 'failed'
                    ? 'close'
                    : icons[moment.kind]}
                  size={16}
                /></span
              >
              <span class="trail-moment-copy"
                ><span class="trail-moment-label">{moment.label}</span><span
                  class="trail-moment-detail"
                  >{moment.detail ||
                    (moment.events[0].parentToolId
                      ? 'Delegated activity'
                      : statusLabel(moment.status))}</span
                >
                <span class="trail-moment-meta"
                  >{moment.status === 'failed'
                    ? 'Failed'
                    : moment.status === 'running'
                      ? 'In progress'
                      : moment.status === 'unknown'
                        ? 'Outcome unavailable'
                        : moment.events.length > 1
                          ? `${moment.events.length} source events`
                          : moment.kind === 'note'
                            ? 'Agent-stated'
                            : moment.kind === 'request'
                              ? 'You'
                              : 'Recorded'}{#if moment.events.length === 1 && moment.events[0].durationMs != null}
                    · {duration(
                      moment.events[0].durationMs,
                    )}{/if}{#if moment.events[0].parentToolId}
                    · Delegated{/if}</span
                >
              </span>
              <span class="trail-ordinal" aria-hidden="true"
                >{String(index + 1).padStart(2, '0')}</span
              >
            </button>
          </li>
        {/each}
      </ol>
      {#if !moments.length}<div class="trail-empty">
          <Icon name="branch" size={25} />
          <h3>
            {historyBusy
              ? 'Loading the trail…'
              : 'The trail starts with activity'}
          </h3>
          <p>
            Searches, file reads, changes, and agent updates will appear here as
            they’re recorded.
          </p>
        </div>{/if}
      {#if saved && nextCursor}{#if savedEvents.length < TRAIL_LIMIT}<button
            class="trail-load-more"
            disabled={historyBusy}
            onclick={() => loadHistory(true)}
            >{historyBusy ? 'Loading…' : 'Load next activity'}</button
          >{:else}<p class="trail-coverage">
            Showing the first {TRAIL_LIMIT} recorded events.
            <button onclick={onhistory}>Open History</button> for more.
          </p>{/if}{/if}
    </div>
    <section class="trail-evidence" aria-label="Moment evidence">
      {#if selected && source}
        <div class="trail-evidence-navigation">
          <button class="trail-back" onclick={backToMoments}
            >← All moments</button
          ><span>Moment {selectedIndex + 1} of {moments.length}</span>
          <div>
            <button
              aria-label="Previous moment"
              disabled={selectedIndex <= 0}
              onclick={() => jumpTo(moments[selectedIndex - 1].key)}
              ><Icon name="chevron-down" size={14} /></button
            ><button
              aria-label="Next moment"
              disabled={selectedIndex >= moments.length - 1}
              onclick={() => jumpTo(moments[selectedIndex + 1].key)}
              ><Icon name="chevron-down" size={14} /></button
            >
          </div>
        </div>
        <div class="trail-evidence-title">
          <span class="eyebrow"
            >{source.kind === 'note'
              ? 'Agent-stated'
              : source.kind === 'request'
                ? 'Your message'
                : 'Recorded evidence'}</span
          >
          <h3 bind:this={evidenceHeading} tabindex="-1">{selected.label}</h3>
        </div>
        {#if selected.events.length > 1}<div
            class="trail-source-picker"
            aria-label="Source events"
          >
            {#each selected.events as event, index}<button
                aria-pressed={source.key === event.key}
                onclick={() => selectEvent(event)}
                >{index + 1}. {event.label}</button
              >{/each}
          </div>{/if}
        {#if source.parentToolId}<p class="trail-delegated">
            Delegated from {parent?.label ?? 'an activity outside this view'}.
          </p>{/if}
        {#if evidenceBusy}<p class="trail-coverage" role="status">
            Loading source…
          </p>{/if}
        {#if evidenceError}<p class="trail-notice error" role="alert">
            {evidenceError}
          </p>{/if}
        {#if displayedEvidence}
          {@const original = displayedEvidence}
          {#if original.text}<blockquote class="trail-quote">
              {original.text.slice(0, 12000)}
            </blockquote>{/if}
          {#if original.command}<div class="trail-command">
              <span class="eyebrow">Command</span>
              <pre>{original.command}</pre>
            </div>{/if}
          {#if source.paths.length}<div class="trail-files">
              {#each source.paths as path}{@const relative = trailPath(
                  path,
                  projectRoot,
                )}{#if relative}<button onclick={() => onopen(relative)}
                    ><Icon name="file" size={14} /><span>{path}</span><Icon
                      name="arrow-right"
                      size={12}
                    /></button
                  >{:else}<span class="trail-file-label">{path}</span
                  >{/if}{/each}
            </div>{/if}
          {#if original.output}<div class="trail-output">
              <span class="eyebrow">Tool output</span>
              <pre>{original.output.slice(0, 12000)}</pre>
            </div>{/if}
          {#if original.files?.some((f) => f.diff)}<div class="trail-output">
              <span class="eyebrow">Recorded patch</span>
              <pre>{original.files
                  .map((f) => f.diff ?? '')
                  .join('\n')
                  .slice(0, 12000)}</pre>
            </div>{/if}
          {#if original.steps?.length}<ol class="trail-plan">
              {#each original.steps as step}<li>
                  {step.step}<small
                    >{step.status === 'inProgress'
                      ? 'Reported in progress'
                      : step.status}</small
                  >
                </li>{/each}
            </ol>{/if}
          {#if original.detail}<details class="trail-tool-details">
              <summary>Tool details</summary>
              <pre>{original.detail.slice(0, 12000)}</pre>
            </details>{/if}
          {#if original.truncated || (original.text?.length ?? 0) > 12000 || (original.output?.length ?? 0) > 12000 || (original.detail?.length ?? 0) > 12000 || (original.files?.reduce((n, f) => n + (f.diff?.length ?? 0), 0) ?? 0) > 12000}<p
              class="trail-coverage"
            >
              This evidence preview is shortened.
            </p>{/if}
        {:else if !evidenceBusy && source.text}<blockquote class="trail-quote">
            {source.text}{source.shortened ? '…' : ''}
          </blockquote>{/if}
        <div class="trail-evidence-footer">
          <span data-status={source.status}
            >{statusLabel(source.status)}{source.exitCode != null
              ? ` · Exit ${source.exitCode}`
              : ''}</span
          >{#if liveEvidence}<button onclick={() => onreveal(source.key)}
              >Show in transcript <Icon name="arrow-right" size={13} /></button
            >{/if}
        </div>
      {:else}<div class="trail-empty trail-evidence-empty">
          <div class="trail-empty-icon"><Icon name="branch" size={28} /></div>
          <h3>The path, with the proof.</h3>
          <p>Choose a moment to see what the agent read, changed, or said.</p>
          <span>Recorded order · No inferred reasoning</span>
        </div>{/if}
    </section>
  </div>
</section>
