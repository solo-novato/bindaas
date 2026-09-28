<script lang="ts">
  import { tick, untrack, onDestroy, onMount } from 'svelte';
  import {
    capturePosition,
    positionTop,
    type ReadingView,
    type ReadingPosition,
  } from '../reading';
  import { api } from '../api';
  import Icon from './Icon.svelte';
  import { flight, pop, rise } from '../motion';
  import {
    duration,
    groupTimeline,
    itemKey,
    type TimelineRow,
  } from '../timeline';
  import type { TimelineItem, Context } from '../types';
  let {
    agentLabel = 'Codex',
    items,
    oncontext,
    onopen,
    projectRoot,
    query = '',
    viewKey,
    savedView,
    onremember,
    followRevision = 0,
    loading = false,
    planActionKey = null,
    runningTurnId = null,
    onplan,
    editableTurnId = null,
    onedit,
  }: {
    agentLabel?: string;
    items: TimelineItem[];
    oncontext: (context: Context) => void;
    onopen: (path: string) => void;
    projectRoot?: string;
    query?: string;
    viewKey: string;
    savedView?: ReadingView;
    onremember: (key: string, view: ReadingView) => void;
    followRevision?: number;
    loading?: boolean;
    planActionKey?: string | null;
    runningTurnId?: string | null;
    onplan: (item: TimelineItem, implement: boolean) => void;
    editableTurnId?: string | null;
    onedit?: (item: TimelineItem) => void;
  } = $props();
  const identity = untrack(() => viewKey);
  const initial = untrack(() => savedView);
  let scroller: HTMLDivElement;
  let following = $state(initial?.following ?? true);
  let expanded = $state<string[]>(initial?.expanded ?? []);
  let expandedGroups = $state<string[]>(initial?.expandedGroups ?? []);
  let windowSize = $state(initial?.windowSize ?? 100);
  let position: ReadingPosition = initial ?? {
    top: 0,
    anchor: null,
    offset: 0,
    following: true,
  };
  let lastView: ReadingView | undefined = initial;
  let expectedScroll: number | null = null;
  let disposed = false;
  let initializing = !!initial;
  onMount(() => {
    void (async () => {
      await tick();
      if (markdownModule) await markdownModule.catch(() => {});
      await tick();
      if (disposed) return;
      initializing = false;
      introReady = true;
      restorePosition();
      remember();
    })();
  });
  let beforeSearch: ReadingPosition | null = null;
  let previousQuery = untrack(() => query);
  let previousRevision = untrack(() => followRevision);
  let matchIndex = $state(0);
  let missingAnchor = $state(false);
  onDestroy(() => {
    disposed = true;
    if (lastView) onremember(identity, lastView);
  });
  function setTop(top: number) {
    if (!scroller || disposed) return;
    scroller.scrollTop = top;
    expectedScroll = scroller.scrollTop;
  }
  function remember() {
    if (!scroller || loading || disposed || initializing) return;
    position = capturePosition(scroller, following);
    const remembered = query && beforeSearch ? beforeSearch : position;
    lastView = {
      ...remembered,
      windowSize,
      expanded: [...expanded],
      expandedGroups: [...expandedGroups],
    };
    onremember(identity, lastView);
  }
  function restorePosition() {
    if (!scroller || loading || disposed) return;
    setTop(positionTop(scroller, { ...position, following }));
    if (following) remember();
    // Keep the anchor while Markdown loads; do not replace it with a clamped offset.
  }
  function pauseReading() {
    missingAnchor = false;
    following = false;
    remember();
  }
  export function focusReader() {
    scroller?.focus({ preventScroll: true });
  }
  export async function reveal(key: string) {
    const index = items.findIndex((item) => itemKey(item) === key);
    if (index < 0) return;
    missingAnchor = false;
    following = false;
    windowSize = Math.max(windowSize, items.length - index);
    const group = groupTimeline(items).find(
      (row) =>
        row.type === 'group' && row.items.some((i) => itemKey(i) === key),
    );
    if (group && !expandedGroups.includes(group.key))
      expandedGroups = [...expandedGroups, group.key];
    position = { top: 0, anchor: key, offset: 12, following: false };
    await tick();
    restorePosition();
    remember();
  }
  async function findMatch(index: number) {
    matchIndex = index;
    const item = matches[index];
    if (item) await reveal(itemKey(item));
  }
  let output = $state<
    Record<string, { text: string; nextOffset: number; total: number }>
  >({});
  let error = $state('');
  let copied = $state('');
  let markdownModule = $state<Promise<
    typeof import('./Markdown.svelte')
  > | null>(null);
  $effect(() => {
    if (
      !markdownModule &&
      items.some(
        (i) =>
          ['message', 'plan'].includes(i.kind) ||
          (i.kind === 'thinking' && !!i.text?.trim()),
      )
    )
      markdownModule = import('./Markdown.svelte');
  });
  function watchSize(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      restorePosition();
    });
    observer.observe(node);
    if (scroller) observer.observe(scroller);
    return { destroy: () => observer.disconnect() };
  }
  async function copyMessage(item: TimelineItem) {
    try {
      await navigator.clipboard.writeText(item.text ?? '');
      copied = `${item.turnId}:${item.id}`;
    } catch {
      error = 'Could not copy. Select the message text and copy it manually.';
    }
  }
  const matches = $derived(
    items.filter(
      (item) =>
        (item.kind !== 'thinking' || !!item.text?.trim()) &&
        (!query ||
          `${item.title} ${item.text ?? ''} ${item.command ?? ''} ${item.steps?.map((step) => step.step).join(' ') ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    ),
  );
  const visible = $derived(matches.slice(-windowSize));
  const prompts = $derived(items.filter((i) => i.kind === 'user'));
  const rows = $derived<TimelineRow[]>(
    query
      ? visible.map((item) => ({ type: 'item', key: itemKey(item), item }))
      : groupTimeline(visible),
  );
  $effect.pre(() => {
    if (query !== previousQuery) {
      if (!previousQuery && query)
        beforeSearch = scroller
          ? capturePosition(scroller, following)
          : position;
      if (!query && beforeSearch) {
        position = beforeSearch;
        following = beforeSearch.following;
        beforeSearch = null;
      } else {
        following = false;
        position = { top: 0, anchor: null, offset: 0, following: false };
      }
      previousQuery = query;
      bulk = true;
      matchIndex = 0;
      const search = query;
      tick().then(() => {
        if (query !== search || disposed) return;
        if (query) findMatch(0);
        else restorePosition();
      });
    }
  });
  $effect(() => {
    items;
    loading;
    if (followRevision !== previousRevision) {
      previousRevision = followRevision;
      following = true;
      position = { top: 0, anchor: null, offset: 0, following: true };
    }
    // New background activity must not push an existing anchor out of the DOM window.
    const anchorIndex = untrack(() =>
      items.findIndex(
        (i) => itemKey(i) === position.anchor?.replace(/^group:/, ''),
      ),
    );
    if (anchorIndex >= 0) {
      windowSize = Math.max(windowSize, items.length - anchorIndex);
      if (!following && !position.anchor?.startsWith('group:')) {
        const group = groupTimeline(items).find(
          (row) =>
            row.type === 'group' &&
            row.items.some((i) => itemKey(i) === position.anchor),
        );
        if (group && !expandedGroups.includes(group.key))
          expandedGroups = [...expandedGroups, group.key];
      }
    } else if (
      !loading &&
      items.length &&
      !following &&
      !query &&
      position.anchor
    ) {
      missingAnchor = true;
      position = { top: 0, anchor: null, offset: 0, following: false };
    }
    tick().then(restorePosition);
  });
  $effect(() => {
    expanded;
    expandedGroups;
    windowSize;
    tick().then(() => {
      restorePosition();
      remember();
    });
  });
  const statusLabels: Record<string, string> = {
    inProgress: 'Running',
    completed: '',
    failed: 'Failed',
    declined: 'Declined',
    interrupted: 'Interrupted',
    recorded: '',
  };
  function statusLabel(status?: string) {
    if (!status) return '';
    return (
      statusLabels[status] ??
      status
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (c) => c.toUpperCase())
    );
  }
  function activityTitle(item: TimelineItem) {
    if (item.kind === 'command') return item.command;
    if (item.kind === 'fileChange') {
      const count = item.files?.length ?? 0;
      const verb = item.status === 'inProgress' ? 'Editing' : 'Edited';
      return `${verb} ${count} ${count === 1 ? 'file' : 'files'}`;
    }
    return item.title;
  }
  // Consecutive replies from the same agent read as one turn, not a stack of cards.
  function continues(row: TimelineRow, previous?: TimelineRow) {
    if (row.type !== 'item' || previous?.type !== 'item') return false;
    const item = row.item,
      prior = previous.item;
    return (
      item.kind === 'message' &&
      prior.kind === 'message' &&
      item.title === prior.title &&
      item.phase !== 'final_answer' &&
      item.status !== 'inProgress' &&
      !item.delivery
    );
  }
  // Only live arrivals animate. Mounting, history pages, and restores stay still
  // so the reading position never moves.
  // A brand-new conversation animates its first message; restored views never do.
  let introReady = untrack(() => !initial && items.length <= 1);
  let lastCount = untrack(() => items.length);
  let bulk = false;
  $effect.pre(() => {
    const count = items.length;
    bulk = loading || count - lastCount > 3;
    lastCount = count;
  });
  function arrive(node: Element, item: TimelineItem) {
    if (!introReady || bulk || query) return { duration: 0 };
    if (item.kind === 'user' && /^(pending|steer)-/.test(item.id))
      return flight(node);
    return rise(node);
  }
  let seenCount = $state(untrack(() => items.length));
  $effect(() => {
    if (following) seenCount = items.length;
  });
  const unseen = $derived(
    following ? 0 : Math.max(0, items.length - seenCount),
  );
  async function loadOutput(item: TimelineItem, offset: number) {
    pauseReading();
    try {
      output[itemKey(item)] = await api.output(
        item.threadId,
        item.turnId,
        item.id,
        offset,
      );
    } catch (e) {
      error = String(e);
    }
  }
</script>

{#if query}<div class="conversation-navigation" aria-label="Search results">
    <span>{matches.length} {matches.length === 1 ? 'match' : 'matches'}</span>
    {#if matches.length}<span class="muted"
        >{matchIndex + 1} of {matches.length}</span
      ><button
        aria-label="Previous match"
        disabled={matchIndex === 0}
        onclick={() => findMatch(matchIndex - 1)}>↑</button
      ><button
        aria-label="Next match"
        disabled={matchIndex >= matches.length - 1}
        onclick={() => findMatch(matchIndex + 1)}>↓</button
      >{/if}
  </div>{:else if prompts.length > 1}<div class="conversation-navigation">
    <span class="muted">Conversation</span><select
      aria-label="Jump to message"
      value=""
      onchange={(e) => {
        if (e.currentTarget.value) reveal(e.currentTarget.value);
        e.currentTarget.value = '';
      }}
      ><option value="" disabled>Jump to a request…</option
      >{#each prompts as item, i}<option value={itemKey(item)}
          >{i + 1} · {(item.text ?? 'Attached context').slice(0, 90)}</option
        >{/each}</select
    >
  </div>{/if}
<div class="timeline-stage">
  {#if missingAnchor}<p class="reading-notice" role="status">
      Your previous place is outside the loaded history. Showing the earliest
      loaded activity.
    </p>{/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable transcript needs keyboard focus for reading.) -->
  <div
    class="timeline"
    role="region"
    aria-label="Conversation transcript"
    tabindex="0"
    bind:this={scroller}
    onscroll={() => {
      if (scroller.scrollTop === expectedScroll) {
        expectedScroll = null;
        return;
      }
      expectedScroll = null;
      following =
        !query &&
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      remember();
    }}
  >
    <div class="timeline-content" use:watchSize>
      {#if items.length > windowSize}<button
          class="load-older"
          onclick={async () => {
            pauseReading();
            const oldHeight = scroller.scrollHeight;
            const oldTop = scroller.scrollTop;
            windowSize += 100;
            await tick();
            setTop(oldTop + scroller.scrollHeight - oldHeight);
            remember();
          }}>Show earlier activity ({items.length - windowSize})</button
        >{/if}
      {#each rows as row, index (row.key)}
        {#if row.type === 'group'}
          {@const latest = row.items[row.items.length - 1]}
          {@const isOpen =
            expandedGroups.includes(row.key) ||
            row.items.some((i) => expanded.includes(itemKey(i)))}
          <section
            class="activity-group"
            data-reading-key={row.key}
            in:arrive|global={latest}
          >
            <button
              class="activity-group-toggle"
              aria-expanded={isOpen}
              onclick={() => {
                pauseReading();
                if (isOpen) {
                  expandedGroups = expandedGroups.filter((k) => k !== row.key);
                  expanded = expanded.filter(
                    (k) => !row.items.some((i) => itemKey(i) === k),
                  );
                } else expandedGroups = [...expandedGroups, row.key];
              }}
            >
              <span class="activity-group-icon" aria-hidden="true"
                ><Icon name="check" size={15} /></span
              >
              <span class="activity-group-copy">
                <span class="activity-group-label"
                  >{row.label}<span class="activity-group-status"
                    >Completed</span
                  ></span
                >
                <span class="activity-group-latest">
                  <span class="activity-group-caption">Last:</span>
                  <span class="activity-group-detail"
                    >{latest.command ||
                      latest.files?.map((file) => file.path).join(', ') ||
                      latest.title ||
                      'Recorded action'}</span
                  >
                  {#if latest.kind === 'command' && latest.exitCode != null}<span
                      class="activity-group-result">Exit {latest.exitCode}</span
                    >{/if}
                </span>
              </span>
              <small>{isOpen ? 'Hide activity' : 'Show activity'}</small><span
                aria-hidden="true">{isOpen ? '−' : '+'}</span
              >
            </button>
            {#if isOpen}<div class="activity-group-items">
                {#each row.items as item (itemKey(item))}{@render activity(
                    item,
                  )}{/each}
              </div>{/if}
          </section>
        {:else}
          {@const item = row.item}
          {#if item.kind === 'message' || item.kind === 'user' || item.kind === 'plan'}<article
              class="message"
              in:arrive|global={item}
              class:streaming={item.status === 'inProgress' &&
                item.kind !== 'user'}
              class:continued={continues(row, rows[index - 1])}
              class:user={item.kind === 'user'}
              class:proposed-plan={item.kind === 'plan'}
              aria-label={item.kind === 'plan' ? 'Proposed plan' : undefined}
              class:final-answer={item.phase === 'final_answer'}
              data-reading-key={itemKey(item)}
            >
              <div class="message-avatar" aria-hidden="true">
                {#if item.kind === 'user'}Y{:else}<Icon
                    name={item.kind === 'plan' ? 'file' : 'workbench'}
                    size={18}
                  />{/if}
              </div>
              <div>
                <div
                  class="message-label"
                  class:sr-label={item.kind === 'user' && !item.delivery}
                >
                  {item.kind === 'plan'
                    ? 'Proposed plan'
                    : item.phase === 'final_answer'
                      ? 'Answer'
                      : item.title}<span
                    >{item.delivery === 'sending'
                      ? `Sending to ${agentLabel}…`
                      : item.delivery === 'accepted'
                        ? 'Sent to running task · awaiting pickup'
                        : item.status === 'inProgress'
                          ? 'Streaming'
                          : ''}</span
                  >
                </div>
                {#if (item.kind === 'message' || item.kind === 'plan') && markdownModule}
                  {#await markdownModule}<div class="message-text">
                      {item.text}
                    </div>{:then module}
                    <module.default
                      text={item.text ?? ''}
                      path="__chat__.md"
                      {projectRoot}
                      {onopen}
                    />
                  {:catch}<div class="message-text">{item.text}</div>{/await}
                {:else}<div class="message-text">{item.text}</div>{/if}
                {#if item.status !== 'inProgress'}<div class="message-actions">
                    <button
                      class:just-copied={copied === `${item.turnId}:${item.id}`}
                      aria-label={`Copy ${item.kind === 'user' ? 'your message' : item.kind === 'plan' ? 'plan' : `${agentLabel} response`}`}
                      onclick={() => copyMessage(item)}
                      >{copied === `${item.turnId}:${item.id}`
                        ? 'Copied ✓'
                        : 'Copy'}</button
                    >
                    {#if item.kind === 'message' || item.kind === 'plan'}<button
                        onclick={() =>
                          oncontext({
                            id: crypto.randomUUID(),
                            label:
                              item.kind === 'plan'
                                ? 'Proposed plan'
                                : `${agentLabel} response`,
                            text: item.text ?? '',
                          })}>Quote in reply</button
                      >{/if}
                    {#if item.kind === 'user' && onedit && !item.delivery && item.turnId === editableTurnId}<button
                        title="Remove this message and what followed, then edit and send it again"
                        onclick={() => onedit(item)}>Rewrite</button
                      >{/if}
                  </div>{/if}
                {#if item.kind === 'plan'}<div class="plan-actions">
                    {#if itemKey(item) === planActionKey}
                      <button onclick={() => onplan(item, false)}
                        >Revise plan</button
                      >
                      <button class="primary" onclick={() => onplan(item, true)}
                        >Prepare implementation</button
                      >
                      <p>
                        Prepares a reply in Plan or Code mode. Review it before
                        sending.
                      </p>
                    {:else if item.status === 'inProgress'}<p>
                        {agentLabel} is drafting this plan…
                      </p>
                    {:else if item.truncated}<p>
                        Plan preview is incomplete. Ask {agentLabel} for the full
                        plan before implementing.
                      </p>
                    {:else}<p>
                        Proposed plan from this conversation. Viewing it does
                        not change the current mode.
                      </p>{/if}
                  </div>{/if}
                {#if item.truncated}<small>Message truncated</small>{/if}
              </div>
            </article>
          {:else if item.kind === 'planProgress'}<section
              class="plan-progress"
              in:arrive|global={item}
              aria-label="Task progress"
              data-reading-key={itemKey(item)}
            >
              <div class="plan-progress-heading">
                <strong
                  >{item.turnId === runningTurnId
                    ? 'Task progress'
                    : 'Last reported task progress'}</strong
                ><span
                  >{item.steps?.filter((step) => step.status === 'completed')
                    .length ?? 0} of {item.steps?.length ?? 0} steps reported complete</span
                >
              </div>
              {#if item.text}<p>{item.text}</p>{/if}
              <ol>
                {#each item.steps ?? [] as step}<li
                    class:step-complete={step.status === 'completed'}
                  >
                    <span aria-hidden="true"
                      >{step.status === 'completed'
                        ? '✓'
                        : step.status === 'inProgress'
                          ? '●'
                          : '○'}</span
                    >
                    <span>{step.step}</span><small
                      >{step.status === 'inProgress'
                        ? item.turnId === runningTurnId
                          ? 'In progress'
                          : 'Was in progress'
                        : step.status === 'completed'
                          ? 'Completed'
                          : 'Pending'}</small
                    >
                  </li>{/each}
              </ol>
              {#if item.truncated}<small>Progress list shortened</small>{/if}
            </section>
          {:else if item.kind === 'thinking'}<section
              class="thinking-summary"
              in:arrive|global={item}
              data-reading-key={itemKey(item)}
              aria-label="Thinking summary"
            >
              <div class="thinking-summary-heading">
                <span class:thinking-dot={item.status === 'inProgress'}
                ></span>{item.status === 'inProgress'
                  ? 'Thinking…'
                  : 'Thinking summary'}
              </div>
              {#if item.text && markdownModule}{#await markdownModule}<p>
                    {item.text}
                  </p>{:then module}<module.default
                    text={item.text}
                    path="__thinking__.md"
                    {projectRoot}
                    {onopen}
                  />{/await}
              {:else}<p>{item.text}</p>{/if}
            </section>
          {:else}{@render activity(item)}{/if}
        {/if}
      {/each}
      {#if query && !visible.length}<p class="timeline-empty">
          No matching messages or activity.
        </p>{/if}
      {#if error}<p class="error">{error}</p>{/if}
    </div>
  </div>
  {#if !following}<button
      class="jump-latest"
      in:pop
      onclick={() => {
        following = true;
        setTop(scroller.scrollHeight);
        remember();
      }}
      >{#if unseen}<span class="new-count" aria-hidden="true">{unseen} new</span
        >{/if}Jump to latest ↓</button
    >{/if}
</div>

{#snippet activity(item: TimelineItem)}
  <div
    class="activity-row"
    in:arrive|global={item}
    class:running={item.status === 'inProgress'}
    data-reading-key={itemKey(item)}
    class:failed={item.status === 'failed' ||
      (item.exitCode != null && item.exitCode !== 0)}
  >
    <button
      class="activity-summary"
      onclick={() => {
        pauseReading();
        expanded = expanded.includes(itemKey(item))
          ? expanded.filter((id) => id !== itemKey(item))
          : [...expanded, itemKey(item)];
      }}
      aria-expanded={expanded.includes(itemKey(item))}
    >
      <span class="activity-icon"
        >{item.status === 'inProgress'
          ? '●'
          : (item.exitCode != null && item.exitCode !== 0) ||
              item.status === 'failed'
            ? '×'
            : '✓'}</span
      ><span class="truncate" class:mono={item.kind === 'command'}
        >{activityTitle(item)}</span
      ><small
        >{item.kind === 'command' && item.exitCode != null
          ? `${item.exitCode === 0 ? 'exit 0' : `exit ${item.exitCode}`} · ${duration(item.durationMs)}`
          : statusLabel(item.status)}</small
      ><span class="activity-chevron" aria-hidden="true"
        ><Icon name="chevron-down" size={13} /></span
      >
    </button>
    {#if expanded.includes(itemKey(item))}<div class="activity-detail">
        {#if item.command}<code>{item.command}</code>
          <p class="muted mono">{item.cwd}</p>{/if}
        {#if item.output || item.kind === 'command'}<pre>{output[itemKey(item)]
              ?.text ??
              item.output ??
              'Waiting for output…'}</pre>
          {#if item.truncated}<p class="muted">
              Output preview truncated. Retained output is capped at 1 MiB per
              command.
            </p>{/if}
          <div class="row">
            <button onclick={() => loadOutput(item, 0)}
              >Load retained output</button
            >{#if output[itemKey(item)]}<button
                disabled={output[itemKey(item)].nextOffset >=
                  output[itemKey(item)].total}
                onclick={() =>
                  loadOutput(item, output[itemKey(item)].nextOffset)}
                >Next page</button
              ><small
                >{output[itemKey(item)].nextOffset} / {output[itemKey(item)]
                  .total} bytes</small
              >{/if}
          </div>{/if}
        {#if item.files}{#each item.files as file}<details>
              <summary class="mono">{file.path}</summary>
              <pre>{file.diff || 'No patch provided'}</pre>
            </details>{/each}{/if}
        {#if item.detail}<pre>{item.detail}</pre>{/if}
        <button
          onclick={() =>
            oncontext({
              id: crypto.randomUUID(),
              label: item.command ?? item.title,
              text: `${item.command ?? item.title}\n${item.cwd ?? ''}\nExit: ${item.exitCode ?? 'unknown'}\n${item.output ?? item.detail ?? ''}`,
            })}>Ask {agentLabel} about this</button
        >
      </div>{/if}
  </div>
{/snippet}
