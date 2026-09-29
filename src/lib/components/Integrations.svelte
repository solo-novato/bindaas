<script lang="ts">
  import { api } from '../api';
  import type { Settings } from '../types';
  let {
    settings,
    onchanged,
  }: { settings: Settings; onchanged: () => Promise<void> } = $props();
  let connecting = $state(false);
  let expanded = $state(false);
  let executable = $state('');
  let auth = $state<'subscription' | 'api'>('subscription');
  let message = $state('');
  let error = $state('');
  async function connect() {
    connecting = true;
    error = '';
    message = '';
    try {
      const result = await api.connectClaude(
        executable.trim() || settings.claudeExecutablePath || null,
      );
      if (result.authenticated) {
        message = `Connected · ${result.version} · ${result.authMethod ?? 'Native CLI authentication'}`;
        await onchanged();
      } else {
        expanded = true;
        message = 'Sign in through the Claude CLI, then check again.';
      }
    } catch (e) {
      expanded = true;
      error = String(e);
    } finally {
      connecting = false;
    }
  }
  async function disconnect() {
    connecting = true;
    error = '';
    try {
      await api.disconnectClaude();
      await onchanged();
      message = 'Disconnected. Your native Claude history is preserved.';
    } catch (e) {
      error = String(e);
    } finally {
      connecting = false;
    }
  }
</script>

<section class="integrations" aria-label="Integrations">
  <h3>Integrations</h3>
  <div class="integration-row">
    <div>
      <strong>Claude Code</strong>
      <p class="muted small">
        {settings.claudeEnabled
          ? 'Connected · Available for new conversations'
          : 'Use Claude Code as well as, or instead of, Codex.'}
      </p>
    </div>
    <button disabled={connecting} onclick={connect}
      >{connecting
        ? 'Checking…'
        : settings.claudeEnabled
          ? 'Check connection'
          : 'Connect Claude Code'}</button
    >
  </div>
  <p class="muted small">
    Each agent keeps its own conversations. Both work with the same project
    files.
  </p>
  <button
    class="text-link"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
    >Setup options {expanded ? '⌃' : '⌄'}</button
  >
  {#if expanded}
    <div class="integration-setup">
      <p>
        Install the official Claude Code CLI, then authenticate in your
        terminal.
      </p>
      <div
        class="segmented"
        role="group"
        aria-label="Claude authentication method"
      >
        <button
          class:chosen={auth === 'subscription'}
          onclick={() => (auth = 'subscription')}>Claude subscription</button
        >
        <button class:chosen={auth === 'api'} onclick={() => (auth = 'api')}
          >API key / Console</button
        >
      </div>
      {#if auth === 'subscription'}<p>
          Use your Claude subscription with the native sign-in:
        </p>
        <code>claude auth login --claudeai</code>
      {:else}<p>Use your Console account:</p>
        <code>claude auth login --console</code>
        <p class="muted small">
          An existing ANTHROPIC_API_KEY configuration also works when available
          to the desktop app. API keys stay in your native CLI environment.
        </p>{/if}
      <p class="muted small">
        Bindaas does not store your subscription tokens or API keys. Sign in
        once, then select Check connection.
      </p>
      <label
        >Claude executable (optional)<input
          aria-label="Claude executable path"
          bind:value={executable}
          placeholder={settings.claudeExecutablePath ||
            'Auto-discover installed Claude Code'}
        /></label
      >
      <button
        onclick={() => api.external('https://code.claude.com/docs/en/setup')}
        >Installation guide ↗</button
      >
      {#if settings.claudeEnabled}<button
          disabled={connecting}
          onclick={disconnect}>Disconnect Claude</button
        >{/if}
    </div>
  {/if}
  {#if message}<p role="status" class="muted small">{message}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</section>

<style>
  .integration-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .integration-row p {
    margin: 6px 0 0;
  }
  .integration-row button {
    flex-shrink: 0;
  }
  .integration-setup {
    margin-top: 16px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .integration-setup label {
    display: grid;
    gap: 8px;
    margin: 16px 0;
  }
  code {
    display: block;
    padding: 12px;
    background: var(--surface);
    border-radius: 6px;
    user-select: all;
  }
</style>
