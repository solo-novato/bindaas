<script lang="ts" module>
  export type Toast = {
    id: number;
    threadId: string;
    title: string;
    tone: 'success' | 'attention' | 'error' | 'plan';
    message: string;
  };
</script>

<script lang="ts">
  import { flip } from 'svelte/animate';
  import { drop, motionEnabled, rise } from '../motion';
  let {
    toasts,
    onopen,
    ondismiss,
  }: {
    toasts: Toast[];
    onopen: (toast: Toast) => void;
    ondismiss: (id: number) => void;
  } = $props();
  const glyph = { success: '✓', attention: '!', error: '×', plan: '◇' };
</script>

<section class="toasts" aria-label="Background task updates" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <div
      class="toast"
      data-tone={toast.tone}
      role="status"
      in:drop
      out:rise={{ y: -6, duration: 180 }}
      animate:flip={{ duration: motionEnabled() ? 240 : 0 }}
    >
      <span class="toast-icon" aria-hidden="true">{glyph[toast.tone]}</span>
      <div class="toast-copy">
        <strong>{toast.title}</strong>
        <small>{toast.message}</small>
      </div>
      <button class="toast-open" onclick={() => onopen(toast)}>Open</button>
      <button
        class="toast-close"
        aria-label={`Dismiss update for ${toast.title}`}
        onclick={() => ondismiss(toast.id)}>×</button
      >
    </div>
  {/each}
</section>

<style>
  .toasts {
    position: fixed;
    top: calc(var(--topbar-height) + 10px);
    right: 14px;
    z-index: 95;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(360px, calc(100vw - 28px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 8px 10px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    background: var(--glass-surface, var(--raised));
    backdrop-filter: var(--glass-blur, none);
    -webkit-backdrop-filter: var(--glass-blur, none);
    box-shadow: var(--shadow-pop);
  }
  .toast-icon {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    font-size: var(--fs-sm);
    font-weight: 700;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 16%, transparent);
  }
  .toast[data-tone='success'] {
    --tone: var(--green);
  }
  .toast[data-tone='attention'] {
    --tone: var(--amber);
  }
  .toast[data-tone='error'] {
    --tone: var(--red);
  }
  .toast[data-tone='plan'] {
    --tone: var(--accent);
  }
  .toast-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .toast-copy strong,
  .toast-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toast-copy strong {
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .toast-copy small {
    font-size: var(--fs-xs);
    color: var(--muted);
  }
  .toast-open {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--accent);
    padding: 4px 8px;
  }
  .toast-close {
    padding: 2px 6px;
    color: var(--muted);
  }
</style>
