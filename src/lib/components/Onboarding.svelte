<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api';
  import Icon from './Icon.svelte';
  import type { ClaudeDetection, CodexDetection } from '../types';
  let {
    account,
    signingIn,
    access,
    projectOpen,
    claudeConnected,
    onsignin,
    onchooseexecutable,
    onaccess,
    onopenproject,
    onclaudeconnected,
    ondone,
  }: {
    account: { type: string; email?: string } | null;
    signingIn: boolean;
    access: 'standard' | 'full';
    projectOpen: boolean;
    claudeConnected: boolean;
    onsignin: () => void;
    onchooseexecutable: () => Promise<unknown>;
    onaccess: (access: 'standard' | 'full') => void;
    onopenproject: () => Promise<unknown>;
    onclaudeconnected: () => Promise<unknown>;
    ondone: () => void;
  } = $props();

  // Bindaas needs one coding agent: the Codex CLI, Claude Code, or both.
  let detection = $state<CodexDetection | null>(null);
  let detectError = $state('');
  let detecting = $state(false);
  let checkingAccount = $state(false);
  let signedIn = $state<{ type: string; email?: string } | null>(null);
  let claude = $state<ClaudeDetection | null>(null);
  let claudeError = $state('');
  let claudeDetecting = $state(false);
  let connecting = $state(false);
  let copied = $state('');
  const who = $derived(account ?? signedIn);
  const codexFound = $derived(!!detection?.supported);
  const codexReady = $derived(codexFound && !!who);
  const agentReady = $derived(codexReady || claudeConnected);

  const codexInstalls = [
    { id: 'npm', label: 'npm', command: 'npm install -g @openai/codex' },
    { id: 'brew', label: 'Homebrew', command: 'brew install codex' },
  ];
  const claudeInstalls = [
    {
      id: 'claude-npm',
      label: 'npm',
      command: 'npm install -g @anthropic-ai/claude-code',
    },
    {
      id: 'claude-native',
      label: 'Installer',
      command: 'curl -fsSL https://claude.ai/install.sh | bash',
    },
  ];
  const notFound = (message: string, fallback: string) =>
    /not found/i.test(message) ? fallback : message;

  async function detect() {
    detecting = true;
    detectError = '';
    try {
      detection = await api.detectCodex();
      if (detection.supported) await checkAccount();
    } catch (e) {
      detection = null;
      // The install commands are shown below; keep the status line short.
      detectError = notFound(
        String(e).replace(/^Error: /, ''),
        'Not installed on this Mac.',
      );
    } finally {
      detecting = false;
    }
  }
  async function checkAccount() {
    checkingAccount = true;
    try {
      signedIn = (await api.account('codex')).account;
    } catch {
      signedIn = null;
    } finally {
      checkingAccount = false;
    }
  }
  async function detectClaude() {
    claudeDetecting = true;
    claudeError = '';
    try {
      claude = await api.detectClaude();
    } catch (e) {
      claude = null;
      claudeError = notFound(
        String(e).replace(/^Error: /, ''),
        'Not installed on this Mac.',
      );
    } finally {
      claudeDetecting = false;
    }
  }
  async function useClaude() {
    connecting = true;
    claudeError = '';
    try {
      const status = await api.connectClaude(null);
      if (status.authenticated) await onclaudeconnected();
      else claudeError = 'Sign in from a terminal first, then check again.';
    } catch (e) {
      claudeError = String(e).replace(/^Error: /, '');
    } finally {
      connecting = false;
    }
  }
  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = id;
      setTimeout(() => (copied = ''), 1600);
    } catch {
      copied = '';
    }
  }
  onMount(() => {
    void detect();
    void detectClaude();
  });
</script>

{#snippet commands(list: { id: string; label: string; command: string }[])}
  <div class="commands">
    {#each list as install}<div class="command">
        <span class="muted">{install.label}</span>
        <code>{install.command}</code>
        <button onclick={() => copy(install.command, install.id)}
          >{copied === install.id ? 'Copied ✓' : 'Copy'}</button
        >
      </div>{/each}
  </div>
{/snippet}

<section class="onboarding" aria-labelledby="onboarding-title">
  <header>
    <div class="welcome-icon" aria-hidden="true">
      <Icon name="workbench" size={26} />
    </div>
    <h1 id="onboarding-title">Set up Bindaas</h1>
    <p>
      Bindaas runs the coding agents already on your Mac — the Codex CLI, Claude
      Code, or both.
    </p>
  </header>

  <ol class="setup-steps">
    <li class="setup-step" data-state={agentReady ? 'done' : 'todo'}>
      <span class="step-mark" class:complete={agentReady} aria-hidden="true"
        >{#if agentReady}<Icon name="check" size={14} />{:else}1{/if}</span
      >
      <div class="step-body">
        <h2>Set up a coding agent</h2>
        <p class="muted small">You need one. You can add the other anytime.</p>
        <div class="agents">
          <article class="agent-card" aria-label="Codex CLI">
            <h3>
              Codex CLI {#if codexReady}<span class="ready-badge">Ready</span
                >{/if}
            </h3>
            {#if detecting}<p class="step-status" role="status">
                Looking for Codex…
              </p>
            {:else if codexReady}<p class="step-status ok" role="status">
                Codex {detection?.version ?? ''} · signed in {who?.email
                  ? `as ${who.email}`
                  : `with ${who?.type}`}
              </p>
            {:else if codexFound && checkingAccount}<p
                class="step-status"
                role="status"
              >
                Found Codex {detection?.version ?? ''}. Checking your account…
              </p>
            {:else if codexFound}<p class="step-status" role="status">
                Found Codex {detection?.version ?? ''} at
                <code>{detection?.path}</code>. Sign in with your ChatGPT
                account, or run <code>codex login</code> in a terminal (API keys work
                too).
              </p>
              <div class="step-actions">
                <button class="primary" disabled={signingIn} onclick={onsignin}
                  >{signingIn
                    ? 'Waiting for browser…'
                    : 'Sign in with ChatGPT ↗'}</button
                >
                <button disabled={checkingAccount} onclick={checkAccount}
                  >I’ve signed in</button
                >
              </div>
            {:else}<p class="step-status warn" role="status">
                {detection
                  ? `Codex ${detection.version} is too old. Update to ${detection.minimum} or later:`
                  : `${detectError || 'Codex was not found.'} Install it with one of these, then check again:`}
              </p>
              {@render commands(codexInstalls)}
              <div class="step-actions">
                <button disabled={detecting} onclick={detect}
                  >Check again</button
                >
                <button
                  disabled={detecting}
                  onclick={async () => {
                    await onchooseexecutable();
                    await detect();
                  }}>Choose Codex executable…</button
                >
              </div>{/if}
          </article>

          <article class="agent-card" aria-label="Claude Code">
            <h3>
              Claude Code {#if claudeConnected}<span class="ready-badge"
                  >Ready</span
                >{/if}
            </h3>
            {#if claudeConnected}<p class="step-status ok" role="status">
                Connected{claude
                  ? ` · Claude Code ${claude.version}${claude.authMethod ? ` · ${claude.authMethod}` : ''}`
                  : ''}
              </p>
            {:else if claudeDetecting}<p class="step-status" role="status">
                Looking for Claude Code…
              </p>
            {:else if claude?.authenticated}<p
                class="step-status"
                role="status"
              >
                Found Claude Code {claude.version}, signed in{claude.authMethod
                  ? ` with ${claude.authMethod}`
                  : ''}.
              </p>
              {#if claudeError}<p class="step-status warn" role="alert">
                  {claudeError}
                </p>{/if}
              <div class="step-actions">
                <button
                  class="primary"
                  disabled={connecting}
                  onclick={useClaude}
                  >{connecting ? 'Connecting…' : 'Use Claude Code'}</button
                >
              </div>
            {:else if claude}<p class="step-status" role="status">
                Found Claude Code {claude.version}. Sign in from a terminal,
                then check again:
              </p>
              {@render commands([
                {
                  id: 'claude-login',
                  label: 'Sign in',
                  command: 'claude auth login',
                },
              ])}
              <div class="step-actions">
                <button disabled={claudeDetecting} onclick={detectClaude}
                  >Check again</button
                >
              </div>
            {:else}<p class="step-status warn" role="status">
                {claudeError || 'Claude Code was not found.'} Install it with one
                of these, sign in with <code>claude auth login</code>, then
                check again:
              </p>
              {@render commands(claudeInstalls)}
              <div class="step-actions">
                <button disabled={claudeDetecting} onclick={detectClaude}
                  >Check again</button
                >
              </div>{/if}
          </article>
        </div>
      </div>
    </li>

    <li class="setup-step" data-state="done">
      <span class="step-mark" aria-hidden="true">2</span>
      <div class="step-body">
        <h2>Choose how much new conversations can do</h2>
        <fieldset class="access-choice">
          <legend class="sr-only">Access for new conversations</legend>
          <label class:chosen={access === 'standard'}
            ><input
              type="radio"
              name="setup-access"
              checked={access === 'standard'}
              onchange={() => onaccess('standard')}
            /><span
              ><strong>Standard (recommended)</strong><small
                >Codex works inside the project and asks before anything more.</small
              ></span
            ></label
          >
          <label class:chosen={access === 'full'}
            ><input
              type="radio"
              name="setup-access"
              checked={access === 'full'}
              onchange={() => onaccess('full')}
            /><span
              ><strong>Full access</strong><small
                >Codex can edit any file and run any command without asking.
                Only for projects you trust.</small
              ></span
            ></label
          >
        </fieldset>
        <p class="muted small">
          Applies to Codex; Claude Code follows its own permission settings. You
          can change this anytime in Settings.
        </p>
      </div>
    </li>
  </ol>

  <footer class="setup-footer">
    <button class="text-link" onclick={ondone}>Skip setup</button>
    <span class="spacer"></span>
    {#if projectOpen}<button class="primary large" onclick={ondone}
        >Start working <Icon name="arrow-right" size={15} /></button
      >{:else}<button class="primary large" onclick={() => onopenproject()}
        ><Icon name="folder" size={17} /> Open a project</button
      >{/if}
  </footer>
</section>

<style>
  .onboarding {
    width: 100%;
    max-width: 640px;
    margin: auto;
    padding: 28px 24px;
    overflow-y: auto;
  }
  header {
    text-align: center;
    margin-bottom: 22px;
  }
  header h1 {
    margin: 0 0 8px;
  }
  header p {
    margin: 0;
    color: var(--muted);
    font-size: var(--fs-md);
  }
  .setup-steps {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .setup-step {
    display: flex;
    gap: 14px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
    animation: rise-in 420ms var(--ease-out) both;
  }
  .setup-step:nth-child(2) {
    animation-delay: 70ms;
  }
  .step-mark {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    font-size: var(--fs-xs);
    font-weight: 700;
    color: var(--muted);
    border: 1px solid var(--border-strong);
  }
  .step-mark.complete {
    color: var(--accent-text);
    border-color: transparent;
    background: var(--green);
  }
  .step-body {
    flex: 1;
    min-width: 0;
  }
  .step-body h2 {
    margin: 2px 0 6px;
    font-size: var(--fs-md);
  }
  .step-status {
    margin: 0 0 8px;
    font-size: var(--fs-sm);
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .step-status.ok {
    color: var(--green);
  }
  .step-status.warn {
    color: var(--amber);
  }
  .commands {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
  }
  .command {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 10px;
    border-radius: var(--r-md);
    background: var(--editor);
    border: 1px solid var(--border);
    font-size: var(--fs-sm);
  }
  .command .muted {
    width: 72px;
    flex-shrink: 0;
    font-size: var(--fs-xs);
  }
  .command code {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .step-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .step-actions button:not(.primary),
  .command button {
    border: 1px solid var(--border);
    font-size: var(--fs-xs);
  }
  .access-choice {
    display: grid;
    gap: 6px;
    margin: 0 0 6px;
    padding: 0;
    border: 0;
  }
  .access-choice label {
    display: flex;
    gap: 10px;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .access-choice label.chosen {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }
  .access-choice input {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .access-choice strong {
    display: block;
    font-size: var(--fs-sm);
  }
  .access-choice small {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: var(--fs-xs);
  }
  .setup-footer {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 18px;
  }
  .setup-footer .spacer {
    flex: 1;
  }
  .agents {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }
  .agent-card {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--editor);
  }
  .agent-card h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
    font-size: var(--fs-sm);
  }
  .ready-badge {
    padding: 1px 7px;
    border-radius: 999px;
    color: var(--green);
    border: 1px solid currentColor;
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .step-body > .muted.small {
    margin: 0;
  }
  .text-link {
    padding: 0;
    color: var(--muted);
    font-size: var(--fs-sm);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .setup-footer .large {
    margin-top: 0;
  }
</style>
