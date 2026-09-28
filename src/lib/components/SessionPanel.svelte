<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { api } from '../api';
  import { agentName } from '../harness';
  import type { Harness } from '../types';
  import SpeedControls from './SpeedControls.svelte';
  import {
    accessDetails,
    profileLabel,
    policyLabel,
    policyOptions,
    tokenNumber,
    windowLabel,
  } from '../session';
  import type {
    AccountStatus,
    Connection,
    PermissionDraft,
    PermissionOptions,
    SessionStatus,
    ThreadSettings,
    TokenUsage,
    SpeedTarget,
  } from '../types';
  let {
    harness = 'codex',
    initialTab,
    running = false,
    threadId,
    root,
    branch,
    status,
    connection,
    settings,
    draft,
    locked,
    onsettings,
    ondraft,
    onclose,
    speedTarget,
    runningTasks,
  }: {
    harness?: Harness;
    initialTab: 'status' | 'permissions';
    running?: boolean;
    threadId: string | null;
    root: string;
    branch: string | null;
    status: string;
    connection: Connection;
    settings: ThreadSettings | null;
    draft: PermissionDraft;
    locked: boolean;
    onsettings: (value: ThreadSettings) => void;
    ondraft: (value: PermissionDraft) => void;
    onclose: () => void;
    speedTarget: SpeedTarget | null;
    runningTasks: SpeedTarget[];
  } = $props();
  const agentLabel = $derived(agentName(harness));
  let tab = $state<'status' | 'permissions'>(untrack(() => initialTab));
  let session = $state<SessionStatus | null>(null);
  let usage = $state<TokenUsage | null>(null);
  let account = $state<AccountStatus | null>(null);
  let options = $state<PermissionOptions | null>(null);
  let sessionLoading = $state(false),
    accountLoading = $state(false),
    optionsLoading = $state(false),
    saving = $state(false);
  let sessionError = $state(''),
    accountError = $state(''),
    optionsError = $state(''),
    saveError = $state(''),
    saved = $state('');
  let chosenProfile = $state(''),
    chosenPolicy = $state('');
  let selectionEdited = $state(false);
  let limitsStale = $state(false),
    copied = $state(false);
  let disposed = false,
    usageRevision = 0,
    settingsRevision = 0;
  let modal: HTMLDialogElement;
  let speedBusy = $state(false);
  const effective = $derived(settings ?? session?.settings ?? null);
  const access = $derived(accessDetails(effective));
  const currentProfile = $derived(
    threadId
      ? (effective?.permissionProfile?.id ?? '')
      : (draft.permissions ?? ''),
  );
  const currentPolicy = $derived(
    threadId
      ? typeof effective?.approvalPolicy === 'string'
        ? effective.approvalPolicy
        : ''
      : (draft.approvalPolicy ?? ''),
  );
  $effect(() => {
    if (!selectionEdited) {
      chosenProfile = currentProfile;
      chosenPolicy = currentPolicy;
    }
  });
  const changed = $derived(
    chosenProfile !== currentProfile || chosenPolicy !== currentPolicy,
  );
  const selected = $derived(
    options?.profiles.find((p) => p.id === chosenProfile),
  );
  const connected = $derived(connection.type === 'ready');
  const input = $derived(usage?.last?.inputTokens);
  const capacity = $derived(usage?.modelContextWindow);
  const percent = $derived(
    typeof input === 'number' && typeof capacity === 'number' && capacity > 0
      ? Math.min(100, Math.max(0, (input / capacity) * 100))
      : null,
  );
  function close() {
    if (!saving && !speedBusy) onclose();
  }
  function mountDialog(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
  async function loadSession() {
    sessionLoading = true;
    sessionError = '';
    const revision = usageRevision,
      settingsAt = settingsRevision;
    try {
      const value = await api.sessionStatus(threadId, harness);
      if (disposed || value.generation < (connection.generation ?? 0)) return;
      session = value;
      if (revision === usageRevision) usage = value.usage;
      if (value.settings && settingsAt === settingsRevision)
        onsettings(value.settings);
    } catch (e) {
      if (!disposed) sessionError = String(e);
    } finally {
      sessionLoading = false;
    }
  }
  async function loadAccount() {
    accountLoading = true;
    accountError = '';
    try {
      const value = await api.accountStatus(harness);
      if (
        !disposed &&
        (harness === 'claude' ||
          value.generation >= (connection.generation ?? 0))
      ) {
        account = value;
        limitsStale = false;
      }
    } catch (e) {
      if (!disposed) accountError = String(e);
    } finally {
      accountLoading = false;
    }
  }
  async function loadOptions() {
    optionsLoading = true;
    optionsError = '';
    try {
      const value = await api.permissionOptions(harness);
      if (!disposed) {
        options = value;
      }
    } catch (e) {
      if (!disposed) optionsError = String(e);
    } finally {
      optionsLoading = false;
    }
  }
  async function switchTab(next: 'status' | 'permissions') {
    tab = next;
    if (next === 'status' && !account && !accountLoading) await loadAccount();
    if (next === 'permissions' && !options && !optionsLoading)
      await loadOptions();
  }
  async function apply() {
    if (saving || locked || !options || !changed) return;
    const patch = {
      permissions:
        chosenProfile !== currentProfile ? chosenProfile || null : null,
      approvalPolicy:
        chosenPolicy !== currentPolicy ? chosenPolicy || null : null,
    };
    saving = true;
    saveError = '';
    saved = '';
    try {
      if (threadId) {
        const value = await api.setPermissions(threadId, patch);
        onsettings(value);
        chosenProfile = value.permissionProfile?.id ?? '';
        chosenPolicy =
          typeof value.approvalPolicy === 'string' ? value.approvalPolicy : '';
        selectionEdited = false;
        saved = 'Permissions updated in Codex.';
      } else {
        ondraft({
          permissions: chosenProfile || null,
          approvalPolicy: chosenPolicy || null,
        });
        selectionEdited = false;
        saved = 'These choices will be sent with your first message.';
      }
    } catch (e) {
      saveError = String(e);
    } finally {
      saving = false;
    }
  }
  onMount(() => {
    const cleanups: UnlistenFn[] = [];
    void (async () => {
      const results = await Promise.allSettled([
        listen<any>('agent://token-usage', ({ payload: p }) => {
          if (
            p.threadId === threadId &&
            p.generation >= (connection.generation ?? 0)
          ) {
            usageRevision++;
            usage = p.usage;
          }
        }),
        listen<any>('agent://thread-settings', ({ payload: p }) => {
          if (
            p.threadId === threadId &&
            p.generation >= (connection.generation ?? 0)
          )
            settingsRevision++;
        }),
        listen<any>('agent://rate-limits-changed', ({ payload: p }) => {
          if (
            (p.harness ?? 'codex') === harness &&
            p.generation >= (connection.generation ?? 0)
          )
            limitsStale = true;
        }),
      ]);
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (disposed) result.value();
          else cleanups.push(result.value);
        } else sessionError = String(result.reason);
      }
      if (disposed) return;
      await Promise.allSettled([
        loadSession(),
        tab === 'status' ? loadAccount() : loadOptions(),
      ]);
    })();
    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  });
</script>

<div class="modal-backdrop">
  <dialog
    bind:this={modal}
    use:mountDialog
    class="session-panel"
    aria-label="Session controls"
    oncancel={(e) => {
      e.preventDefault();
      close();
    }}
  >
    <div class="panel-chrome">
      <header class="panel-heading">
        <div>
          <p class="eyebrow">{agentLabel.toUpperCase()} SESSION</p>
          <h2>{tab === 'status' ? 'Session status' : 'Permissions'}</h2>
        </div>
        <button
          aria-label="Close session controls"
          disabled={saving || speedBusy}
          onclick={close}>×</button
        >
      </header>
      <div class="panel-tabs" role="tablist" aria-label="Session controls">
        <button
          role="tab"
          aria-selected={tab === 'status'}
          disabled={saving || speedBusy}
          onclick={() => switchTab('status')}>Overview</button
        >
        <button
          role="tab"
          aria-selected={tab === 'permissions'}
          disabled={saving || speedBusy}
          onclick={() => switchTab('permissions')}>Permissions</button
        >
      </div>
    </div>
    <div class="panel-content">
      {#if !connected}<p class="banner warning">
          {connection.type === 'sleeping'
            ? `${agentLabel} is sleeping.`
            : `${agentLabel} is not connected.`} Values shown are last reported. Refresh
          to reconnect.
        </p>{/if}
      {#if sessionError}<p class="banner error" role="alert">
          {sessionError}
        </p>{/if}
      {#if running}<p class="notice">
          Conversation permissions apply to the next turn. The running turn
          keeps the access it started with.
        </p>{/if}
      {#if tab === 'status'}
        {#if !threadId}<p class="muted">
            Send your first message to create a {agentLabel} session. Your composer
            choices apply when it starts.
          </p>{/if}
        <section class="session-summary">
          <div class="row">
            <strong>{status}</strong><button
              disabled={sessionLoading || accountLoading}
              onclick={() => Promise.allSettled([loadSession(), loadAccount()])}
              >{sessionLoading || accountLoading
                ? 'Refreshing…'
                : '↻ Refresh status'}</button
            >
          </div>
          <p class="session-name">
            {session?.thread?.name ||
              session?.thread?.preview ||
              (threadId ? 'Current conversation' : 'New conversation')}
          </p>
          <dl class="session-facts">
            <dt>Model</dt>
            <dd>{effective?.model ?? 'Not reported'}</dd>
            <dt>Reasoning</dt>
            <dd>
              {effective?.effort ?? `${agentLabel} default / not reported`}
            </dd>
            <dt>Mode</dt>
            <dd>
              {effective?.mode === 'plan'
                ? 'Plan'
                : effective?.mode === 'default'
                  ? 'Code'
                  : 'Not reported'}
            </dd>
            <dt>Permissions</dt>
            <dd>
              <button class="text-link" onclick={() => switchTab('permissions')}
                >{access.label} →</button
              >
            </dd>
            <dt>Approvals</dt>
            <dd>{policyLabel(effective?.approvalPolicy)}</dd>
            <dt>Project</dt>
            <dd class="path">{effective?.cwd ?? root}</dd>
            {#if branch}<dt>Branch</dt>
              <dd>{branch}</dd>{/if}
          </dl>
        </section>
        {#if harness === 'codex'}<SpeedControls
            selected={speedTarget}
            running={runningTasks}
            {connection}
            reportedTier={effective?.serviceTier}
            disabled={saving || sessionLoading}
            onbusy={(value) => (speedBusy = value)}
            onupdated={() => void loadSession()}
          />{/if}
        <section>
          <h3>Context & tokens</h3>
          {#if usage}<div class="usage-heading">
              <span>Last input</span><strong
                >{`${tokenNumber(input)}${capacity ? ` / ${tokenNumber(capacity)} tokens` : ''}`}</strong
              >
            </div>
            {#if percent !== null}<meter
                min="0"
                max="100"
                value={percent}
                aria-label="Last input as percentage of context window"
              ></meter>{/if}
            <p class="muted small">
              Last reported model input. Conversation totals include repeated
              context across requests.
            </p>
            <dl class="session-facts">
              <dt>
                {usage.scope === 'turn'
                  ? 'Latest turn total'
                  : 'Conversation total'}
              </dt>
              <dd>{tokenNumber(usage.total.totalTokens)}</dd>
              <dt>Input / output</dt>
              <dd>
                {tokenNumber(usage.total.inputTokens)} / {tokenNumber(
                  usage.total.outputTokens,
                )}
              </dd>
              {#if typeof usage.estimatedCostUsd === 'number'}<dt>
                  Reported API cost
                </dt>
                <dd>
                  ${usage.estimatedCostUsd.toFixed(4)}<small class="muted">
                    · not a subscription charge</small
                  >
                </dd>{/if}
              <dt>Cached input</dt>
              <dd>{tokenNumber(usage.total.cachedInputTokens)}</dd>
            </dl>
          {:else}<p class="muted">
              {sessionLoading
                ? 'Reading token usage…'
                : `${agentLabel} has not reported token usage for this conversation.`}
            </p>{/if}
        </section>
        <section>
          <h3>Account & limits</h3>
          {#if accountLoading}<p class="muted">
              Reading account limits…
            </p>{:else if account?.account}<p>
              {[
                account.account.email ?? account.account.type,
                account.account.planType,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>{/if}
          {#if accountError || account?.accountError || account?.limitsError}<p
              class="muted"
            >
              {accountError || account?.accountError || account?.limitsError}
            </p>{/if}
          {#if account?.limits?.ordinaryUsageAllowed === false}<p
              class="banner warning"
            >
              Codex reports that included usage is currently unavailable.
            </p>{/if}
          {#each account?.limits?.buckets ?? [] as bucket}<div
              class="limit-bucket"
            >
              <strong
                >{[bucket.name ?? bucket.id ?? 'Codex usage', bucket.plan]
                  .filter(Boolean)
                  .join(' · ')}</strong
              >
              {#each [bucket.primary, bucket.secondary].filter((w) => w !== null) as window}<div
                  class="usage-heading"
                >
                  <span>{windowLabel(window.windowDurationMins)}</span><strong
                    >{typeof window.usedPercent === 'number'
                      ? `${Math.max(0, Math.min(100, 100 - window.usedPercent)).toFixed(0)}% remaining`
                      : 'Not reported'}</strong
                  >
                </div>
                {#if typeof window.usedPercent === 'number'}<meter
                    min="0"
                    max="100"
                    value={Math.max(0, Math.min(100, 100 - window.usedPercent))}
                    aria-label={`${windowLabel(window.windowDurationMins)} remaining`}
                  ></meter>{/if}
                {#if window.resetsAt}<p class="muted small">
                    Resets {new Date(window.resetsAt * 1000).toLocaleString()}
                  </p>{/if}
              {/each}
            </div>{/each}
          {#if !accountLoading && !account?.limits?.buckets.length && !account?.limitsError && !accountError}<p
              class="muted"
            >
              Account limits are not available.
            </p>{/if}
          {#if limitsStale}<p class="muted small">
              New usage information is available. Refresh status for current
              limits.
            </p>{/if}
        </section>
        {#if threadId}<details>
            <summary>Session details</summary>
            <dl class="session-facts">
              <dt>Thread</dt>
              <dd class="path">
                {threadId}<button
                  onclick={async () => {
                    try {
                      await navigator.clipboard.writeText(threadId!);
                      copied = true;
                    } catch {
                      sessionError = 'Could not copy the thread ID.';
                    }
                  }}>{copied ? 'Copied' : 'Copy thread ID'}</button
                >
              </dd>
              <dt>Provider</dt>
              <dd>{effective?.modelProvider ?? 'Not reported'}</dd>
              <dt>Service tier</dt>
              <dd>
                {effective?.serviceTier ??
                  `${agentLabel} default / not reported`}
              </dd>
              <dt>Approval reviewer</dt>
              <dd>
                {typeof effective?.approvalsReviewer === 'string'
                  ? effective.approvalsReviewer
                  : 'Not reported'}
              </dd>
            </dl>
          </details>{/if}
      {:else if harness === 'claude'}
        <section>
          <h3>Native Claude permissions</h3>
          <p>
            Claude uses the permission rules from your CLI and project
            configuration. Tool requests that need a decision appear in this
            conversation.
          </p>
          <dl class="session-facts">
            <dt>Current mode</dt>
            <dd>{effective?.approvalPolicy ?? 'Native CLI default'}</dd>
            <dt>Project</dt>
            <dd class="path">{root}</dd>
          </dl>
          <p class="muted small">
            Plan mode can be selected in the composer. Permission profiles and
            Fast mode belong to Codex and do not apply to Claude.
          </p>
          <button
            onclick={() =>
              api.external('https://code.claude.com/docs/en/permissions')}
            >Claude permission guide ↗</button
          >
        </section>
      {:else}
        <p class="muted">
          {threadId
            ? 'Control access for this conversation. Changes apply to subsequent tasks.'
            : 'Choose access for your next conversation. Codex receives these choices with your first message.'}
        </p>
        {#if locked}<p class="banner">
            Finish or stop the current task and resolve pending approvals before
            changing permissions.
          </p>{/if}
        {#if optionsError}<p class="banner error" role="alert">
            {optionsError}
          </p>
          <button onclick={loadOptions}>Retry permissions</button>{/if}
        {#if optionsLoading}<p class="muted">
            Reading permission profiles from Codex…
          </p>{/if}
        <fieldset disabled={locked || saving || optionsLoading || !options}>
          <legend>File & network access</legend>
          {#if !threadId}<label class="permission-choice"
              ><input
                type="radio"
                name="profile"
                value=""
                bind:group={chosenProfile}
                onchange={() => (selectionEdited = true)}
              /><span
                ><strong>Default for new conversations</strong><small
                  >Uses the access chosen in Settings → New conversations.</small
                ></span
              ></label
            >{/if}
          {#if threadId && (!currentProfile || !options?.profiles.some((p) => p.id === currentProfile))}<p
              class="muted small"
            >
              Current access: {access.label}. Select a profile to change it.
            </p>{/if}
          {#each options?.profiles ?? [] as profile}<label
              class="permission-choice"
              class:unavailable={!profile.allowed}
              ><input
                type="radio"
                name="profile"
                value={profile.id}
                bind:group={chosenProfile}
                onchange={() => (selectionEdited = true)}
                disabled={!profile.allowed}
              /><span
                ><strong>{profileLabel(profile.id)}</strong><small
                  >{profile.description ??
                    (profile.id === ':read-only'
                      ? 'Read files without changing them. Additional access depends on approval settings.'
                      : profile.id === ':workspace'
                        ? 'Work within the project and permitted folders. Network access follows Codex’s profile.'
                        : profile.id === ':danger-full-access'
                          ? 'Allow access to all files and the network available to Codex.'
                          : 'Custom profile defined in your Codex configuration.')}</small
                >{#if !profile.allowed}<small
                    >Unavailable under your Codex policy.</small
                  >{/if}</span
              ></label
            >{/each}
        </fieldset>
        <fieldset disabled={locked || saving || optionsLoading || !options}>
          <legend>When to ask for approval</legend>
          <select
            aria-label="Approval behavior"
            bind:value={chosenPolicy}
            onchange={() => (selectionEdited = true)}
            ><option value="" disabled={!!threadId}
              >{threadId
                ? policyLabel(effective?.approvalPolicy)
                : 'Default for new conversations'}</option
            >{#each policyOptions.filter( (p) => options?.approvalPolicies.includes(p.id) ) as policy}<option
                value={policy.id}>{policy.label}</option
              >{/each}{#if currentPolicy && !options?.approvalPolicies.includes(currentPolicy)}<option
                value={currentPolicy}
                disabled>{policyLabel(currentPolicy)} (current)</option
              >{/if}</select
          >
          <p class="muted small">
            {policyOptions.find((p) => p.id === chosenPolicy)?.description ??
              'Keep the current Codex approval rules.'}
          </p>
        </fieldset>
        {#if chosenProfile === ':danger-full-access' && chosenProfile !== currentProfile}<p
            class="banner warning"
          >
            Full access allows changes outside this project and unrestricted
            network access. Apply only if that is the access you intend to
            grant.
          </p>{/if}
        {#if threadId}<details open>
            <summary>Current access reported by Codex</summary>
            <dl class="session-facts">
              <dt>Files</dt>
              <dd>{access.files}</dd>
              <dt>Network</dt>
              <dd>{access.network}</dd>
              {#if access.roots.length}<dt>Writable folders</dt>
                <dd>
                  {#each access.roots as path}<div class="path">
                      {path}
                    </div>{/each}{#if access.temporary}<div class="muted small">
                      Codex also permits temporary folders.
                    </div>{/if}
                </dd>{/if}
            </dl>
          </details>{/if}
        {#if saveError}<p class="banner error" role="alert">
            {saveError}
          </p>{/if}{#if saved}<p role="status" class="success-note">
            {saved}
          </p>{/if}
        <div class="panel-actions">
          <button disabled={saving} onclick={close}>Close</button><button
            class="primary"
            disabled={locked ||
              saving ||
              !options ||
              !changed ||
              (!!chosenProfile && !selected?.allowed)}
            onclick={apply}
            >{saving
              ? 'Applying…'
              : threadId
                ? 'Apply permissions'
                : 'Use for new conversation'}</button
          >
        </div>
      {/if}
    </div>
  </dialog>
</div>

<style>
  .session-panel {
    width: min(600px, calc(100vw - 40px));
    max-height: 85vh;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    background: var(--glass-surface, var(--raised));
    backdrop-filter: var(--glass-blur, none);
    -webkit-backdrop-filter: var(--glass-blur, none);
    color: var(--text);
    box-shadow: var(--shadow-pop);
    overflow: auto;
    animation: panel-in 380ms var(--ease-spring);
  }
  @keyframes panel-in {
    from {
      opacity: 0;
      transform: translateY(-10px) scale(0.965);
    }
  }
  .panel-chrome {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--glass-surface, var(--raised));
  }
  .panel-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 18px 20px 12px;
  }
  .panel-heading > button {
    width: 28px;
    height: 28px;
    padding: 0;
    font-size: 18px;
    color: var(--muted);
  }
  h2 {
    margin: 4px 0 0;
    font-size: var(--fs-xl);
  }
  h3 {
    font-size: 14px;
    margin: 0 0 14px;
  }
  .panel-tabs {
    display: flex;
    gap: 4px;
    padding: 0 20px 10px;
    border-bottom: 1px solid var(--border);
  }
  .panel-tabs button[aria-selected='true'] {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
  }
  .panel-content {
    padding: 18px 20px 22px;
  }
  section {
    padding-bottom: 20px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .session-name {
    margin: 12px 0;
    overflow-wrap: anywhere;
    max-height: 4.5em;
    overflow: auto;
  }
  .session-facts {
    display: grid;
    grid-template-columns: 135px minmax(0, 1fr);
    gap: 10px 16px;
    margin: 14px 0 0;
    font-size: 12px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .path {
    font-family: var(--mono);
    font-size: 11px;
    word-break: break-word;
  }
  .path button {
    display: block;
    margin-top: 8px;
  }
  .text-link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
  }
  .usage-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    margin: 12px 0 6px;
  }
  meter {
    display: block;
    width: 100%;
    height: 9px;
    accent-color: var(--accent);
  }
  meter::-webkit-meter-bar {
    background: var(--surface);
    border: 0;
  }
  meter::-webkit-meter-optimum-value {
    background: var(--accent);
  }
  .limit-bucket + .limit-bucket {
    margin-top: 20px;
  }
  .limit-bucket > strong {
    font-size: 12px;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 22px 0;
  }
  legend {
    font-weight: 600;
    margin-bottom: 10px;
    font-size: 13px;
  }
  .permission-choice {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    border: 1px solid var(--border);
    padding: 12px;
    border-radius: 9px;
    margin-bottom: 8px;
    cursor: pointer;
  }
  .permission-choice:has(input:checked) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }
  .permission-choice input {
    width: auto;
    margin: 3px 0;
    accent-color: var(--accent);
  }
  .permission-choice strong {
    display: block;
    font-size: 13px;
  }
  .permission-choice small {
    display: block;
    color: var(--muted);
    margin-top: 4px;
    line-height: 1.5;
  }
  .unavailable {
    opacity: 0.55;
    cursor: not-allowed;
  }
  fieldset select {
    width: 100%;
  }
  .panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
  .success-note {
    font-size: 12px;
    color: var(--accent);
  }
  details summary {
    font-size: 12px;
    cursor: pointer;
    color: var(--muted);
  }
</style>
