<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../api';
  import Icon from './Icon.svelte';
  import type { CodexDetection } from '../types';
  let {
    account,
    signingIn,
    access,
    projectOpen,
    onsignin,
    onchooseexecutable,
    onaccess,
    onopenproject,
    ondone,
  }: {
    account: { type: string; email?: string } | null;
    signingIn: boolean;
    access: 'standard' | 'full';
    projectOpen: boolean;
    onsignin: () => void;
    onchooseexecutable: () => Promise<unknown>;
    onaccess: (access: 'standard' | 'full') => void;
    onopenproject: () => Promise<unknown>;
    ondone: () => void;
  } = $props();

  let detection = $state<CodexDetection | null>(null);
  let detectError = $state('');
  let detecting = $state(false);
  let checkingAccount = $state(false);
  let signedIn = $state<{ type: string; email?: string } | null>(null);
  let copied = $state('');
  const who = $derived(account ?? signedIn);
  const codexReady = $derived(!!detection?.supported);

  const installs = [
    { id: 'npm', label: 'npm', command: 'npm install -g @openai/codex' },
    { id: 'brew', label: 'Homebrew', command: 'brew install codex' },
  ];

  async function detect() {
    detecting = true;
    detectError = '';
    try {
      detection = await api.detectCodex();
      if (detection.supported) await checkAccount();
    } catch (e) {
      detection = null;
      const message = String(e).replace(/^Error: /, '');
      // The install commands are shown below; keep the status line short.
      detectError = /not found/i.test(message)
        ? 'Codex CLI not found on this Mac.'
        : message;
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
  });
</script>

<section class="onboarding" aria-labelledby="onboarding-title">
  <header>
    <div class="welcome-icon" aria-hidden="true">
      <Icon name="workbench" size={26} />
    </div>
    <h1 id="onboarding-title">Set up Bindaas</h1>
    <p>
      Bindaas runs the coding agents already on your Mac. Three quick steps and
      you’re in.
    </p>
  </header>

  <ol class="setup-steps">
    <li class="setup-step" data-state={codexReady ? 'done' : 'todo'}>
      <span class="step-mark" class:complete={!!codexReady} aria-hidden="true"
        >{#if codexReady}<Icon name="check" size={14} />{:else}1{/if}</span
      >
      <div class="step-body">
        <h2>Install the Codex CLI</h2>
        {#if detecting}<p class="step-status" role="status">
            Looking for Codex…
          </p>
        {:else if detection && detection.supported}<p
            class="step-status ok"
            role="status"
          >
            Found Codex {detection.version ?? ''} at
            <code>{detection.path}</code>
          </p>
        {:else if detection}<p class="step-status warn" role="status">
            Codex {detection.version} is too old. Update to {detection.minimum} or
            later with one of the commands below.
          </p>
        {:else}<p class="step-status warn" role="status">
            {detectError || 'Codex was not found.'} Install it with one of these,
            then check again:
          </p>{/if}
        {#if !codexReady && !detecting}
          <div class="commands">
            {#each installs as install}<div class="command">
                <span class="muted">{install.label}</span>
                <code>{install.command}</code>
                <button onclick={() => copy(install.command, install.id)}
                  >{copied === install.id ? 'Copied ✓' : 'Copy'}</button
                >
              </div>{/each}
          </div>
        {/if}
        <div class="step-actions">
          <button disabled={detecting} onclick={detect}
            >{detection || detectError ? 'Check again' : 'Check'}</button
          >
          <button
            disabled={detecting}
            onclick={async () => {
              await onchooseexecutable();
              await detect();
            }}>Choose Codex executable…</button
          >
        </div>
      </div>
    </li>

    <li
      class="setup-step"
      data-state={who ? 'done' : codexReady ? 'todo' : 'blocked'}
    >
      <span class="step-mark" class:complete={!!who} aria-hidden="true"
        >{#if who}<Icon name="check" size={14} />{:else}2{/if}</span
      >
      <div class="step-body">
        <h2>Sign in to Codex</h2>
        {#if who}<p class="step-status ok" role="status">
            Signed in {who.email ? `as ${who.email}` : `with ${who.type}`}
          </p>
        {:else if checkingAccount}<p class="step-status" role="status">
            Checking your Codex account…
          </p>
        {:else}<p class="step-status">
            Use your ChatGPT account, or run <code>codex login</code> in a terminal
            (API keys work too). Bindaas never sees your credentials.
          </p>
          <div class="step-actions">
            <button
              class="primary"
              disabled={!codexReady || signingIn}
              onclick={onsignin}
              >{signingIn
                ? 'Waiting for browser…'
                : 'Sign in with ChatGPT ↗'}</button
            >
            <button
              disabled={!codexReady || checkingAccount}
              onclick={checkAccount}>I’ve signed in</button
            >
          </div>{/if}
      </div>
    </li>

    <li class="setup-step" data-state="done">
      <span class="step-mark" aria-hidden="true">3</span>
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
        <p class="muted small">You can change this anytime in Settings.</p>
      </div>
    </li>
  </ol>

  <footer class="setup-footer">
    <button class="text-link" onclick={ondone}>Skip setup</button>
    <p class="muted small">
      Optional: add Claude Code later in Settings → Integrations.
    </p>
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
  .setup-step:nth-child(3) {
    animation-delay: 140ms;
  }
  .setup-step[data-state='blocked'] {
    opacity: 0.6;
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
  .setup-footer p {
    flex: 1;
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
