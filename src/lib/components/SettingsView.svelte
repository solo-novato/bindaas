<script lang="ts">
  // Settings page. State lives in App; this view renders it and reports actions.
  import Integrations from './Integrations.svelte';
  import type { Connection, Settings } from '../types';
  import type { MotionMode } from '../motion';
  let {
    settings = $bindable(),
    codex,
    codexAccount,
    codexRequiresAuth,
    login,
    busy,
    canSleep,
    debug,
    onintegrations,
    onaccess,
    onconnect,
    onsleep,
    onsignin,
    onopenlogin,
    oncancellogin,
    onchooseexecutable,
    ontestnotification,
    onmotion,
    onsave,
    oncopydiagnostics,
    onnotices,
    onrunsetup,
  }: {
    settings: Settings | null;
    codex: (Connection & { version?: string | null }) | undefined;
    codexAccount: { type: string; email?: string } | null;
    codexRequiresAuth: boolean;
    login: { loginId: string; authUrl: string } | null;
    busy: boolean;
    canSleep: boolean;
    debug?: () => unknown;
    onintegrations: () => Promise<void>;
    onaccess: (access: 'standard' | 'full') => void;
    onconnect: () => void;
    onsleep: () => void;
    onsignin: () => void;
    onopenlogin: () => void;
    oncancellogin: () => void;
    onchooseexecutable: () => void;
    ontestnotification: () => Promise<boolean>;
    onmotion: (mode: MotionMode) => void;
    onsave: () => void;
    oncopydiagnostics: () => Promise<boolean>;
    onnotices: () => void;
    onrunsetup: () => void;
  } = $props();
  let notificationMessage = $state('');
  let diagnosticsNote = $state('');
</script>

<div class="settings">
  <h1>Settings</h1>
  <p class="muted settings-intro">
    Preferences for this Mac. Conversations, models, and sign-in stay with each
    agent.
  </p>
  {#if settings}<Integrations {settings} onchanged={onintegrations} />{/if}
  <section class="settings-access">
    <h3>New conversations</h3>
    <label
      >Start new conversations with<select
        aria-label="New conversation access"
        value={settings?.newChatAccess === 'full' ? 'full' : 'standard'}
        disabled={!settings}
        onchange={(e) =>
          onaccess(e.currentTarget.value === 'full' ? 'full' : 'standard')}
        ><option value="standard"
          >Standard — workspace access, ask when needed</option
        ><option value="full"
          >Full access — never ask (trusted projects only)</option
        ></select
      ></label
    >
    <p class="muted small">
      Applies to conversations you start in Bindaas. Existing conversations keep
      their own permissions; change them anytime from the composer’s permissions
      button.
      {#if settings?.newChatAccess === 'full'}<strong class="warning"
          >Full access lets Codex edit any file and run any command without
          asking.</strong
        >{/if}
    </p>
  </section>
  <section>
    <h3>Codex connection</h3>
    <p class="muted">
      Uses your installed Codex CLI and its account. Codex owns sign-in and
      conversation history.
    </p>
    <div class="connection-card">
      <span
        class="agent-status"
        class:ready={codex?.type === 'ready'}
        class:bad={codex?.type === 'failed' || codex?.type === 'disconnected'}
        ><i></i>{{
          ready: 'Connected',
          sleeping: 'Sleeping — starts on demand',
          starting: 'Starting…',
          connecting: 'Connecting…',
          disconnected: 'Disconnected',
          failed: 'Setup required',
        }[codex?.type ?? 'sleeping'] ??
          codex?.type}{#if codex?.type === 'ready' && codex.version}
          · Codex {codex.version}{/if}</span
      ><button disabled={busy} onclick={onconnect}
        >{busy ? 'Connecting…' : 'Connect / refresh'}</button
      ><button disabled={!canSleep} onclick={onsleep}>Sleep now</button>
    </div>
    {#if codexAccount}<p>
        Signed in {codexAccount.email
          ? `as ${codexAccount.email}`
          : `with ${codexAccount.type}`}
      </p>{:else}<p>
        {codexRequiresAuth
          ? 'Sign in to start a task.'
          : 'Connect to check which account Codex is using.'}
      </p>
      <button onclick={onsignin}>Sign in with ChatGPT ↗</button
      >{/if}{#if login}<div class="banner">
        <span>Waiting for browser sign-in…</span><button onclick={onopenlogin}
          >Open sign-in page</button
        ><button onclick={oncancellogin}>Cancel login</button>
      </div>{/if}
  </section>
  {#if settings}<section>
      <label
        >Codex executable
        <div class="row">
          <input
            aria-label="Codex executable path"
            bind:value={settings.codexExecutablePath}
            placeholder="Auto-discover installed Codex"
          /><button onclick={onchooseexecutable}>Choose…</button><button
            onclick={() => (settings!.codexExecutablePath = null)}>Auto</button
          >
        </div></label
      ><label
        >Idle timeout (seconds)<input
          type="number"
          min="5"
          max="86400"
          bind:value={settings.codexIdleTimeoutSeconds}
        /></label
      >
      <p class="muted small">
        Sleeps only when no task, approval, request, or login is active.
      </p>
    </section>
    <section>
      <h3>Desktop notifications</h3>
      <label class="notification-toggle"
        ><input type="checkbox" bind:checked={settings.desktopNotifications} /> Notify
        when tasks finish, fail, or need input</label
      >
      <p class="muted small">
        Includes conversation titles. Save preferences to apply. macOS
        notification settings and Focus control whether banners appear.
      </p>
      <button
        onclick={async () => {
          if (await ontestnotification())
            notificationMessage =
              'Test notification requested. If no banner appears, enable Bindaas in System Settings → Notifications.';
        }}>Test notification</button
      >
      {#if notificationMessage}<p role="status">
          {notificationMessage}
        </p>{/if}
    </section>
    <section>
      <label
        >Appearance<select bind:value={settings.appearance}
          ><option value="dark">Dark</option><option value="light">Light</option
          ><option value="system">System</option></select
        ></label
      ><label
        >Motion<select
          aria-label="Motion"
          value={settings.motion ?? 'expressive'}
          onchange={(e) => onmotion(e.currentTarget.value as MotionMode)}
          ><option value="expressive">Expressive</option><option value="saving"
            >Power saving — no animations</option
          ></select
        ></label
      >
      <p class="muted small">
        Power saving turns off animations, blur, and ambient effects. It applies
        immediately. Shortcut: ⌘⇧M.
      </p>
    </section>
    <button class="primary" onclick={onsave}>Save preferences</button>
    <section class="settings-about" aria-labelledby="about-title">
      <h3 id="about-title">About</h3>
      <p>
        <strong>Bindaas {__APP_VERSION__}</strong> · MIT License · open source
      </p>
      <p class="muted small">
        Unofficial. Not affiliated with or endorsed by OpenAI or Anthropic.
        Codex and ChatGPT are trademarks of OpenAI; Claude is a trademark of
        Anthropic. Bindaas runs the CLIs installed on your Mac with your own
        accounts and sends no telemetry.
      </p>
      <div class="row">
        <button
          onclick={async () => {
            if (await oncopydiagnostics())
              diagnosticsNote =
                'Copied. Paste it into your bug report — it contains no file contents or conversations.';
          }}>Copy diagnostics</button
        ><button onclick={onnotices}>Third-party notices</button><button
          onclick={onrunsetup}>Run setup again</button
        >
      </div>
      {#if diagnosticsNote}<p class="muted small" role="status">
          {diagnosticsNote}
        </p>{/if}
    </section>{/if}
  {#if import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === '1' && debug}<details
    >
      <summary>Developer diagnostics</summary>
      <pre>{JSON.stringify(debug(), null, 2)}</pre>
    </details>{/if}
</div>
