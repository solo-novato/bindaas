<script lang="ts" module>
  export type TreeAction =
    | 'open'
    | 'open-default'
    | 'new-file'
    | 'new-folder'
    | 'rename'
    | 'copy-path'
    | 'copy-absolute'
    | 'reveal'
    | 'add-chat'
    | 'trash';
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Entry } from '../types';
  let {
    entry,
    x,
    y,
    returnFocus,
    onaction,
    onclose,
  }: {
    entry: Entry | null;
    x: number;
    y: number;
    returnFocus?: HTMLElement | null;
    onaction: (action: TreeAction) => void;
    onclose: () => void;
  } = $props();
  type Item = { action: TreeAction; label: string; hint?: string } | 'divider';
  const items = $derived<Item[]>(
    !entry
      ? [
          { action: 'new-file', label: 'New file' },
          { action: 'new-folder', label: 'New folder' },
        ]
      : entry.directory
        ? [
            { action: 'new-file', label: 'New file' },
            { action: 'new-folder', label: 'New folder' },
            'divider',
            { action: 'add-chat', label: 'Add to chat' },
            { action: 'copy-path', label: 'Copy relative path' },
            { action: 'copy-absolute', label: 'Copy absolute path' },
            { action: 'reveal', label: 'Reveal in Finder' },
            'divider',
            { action: 'rename', label: 'Rename…', hint: 'F2' },
            { action: 'trash', label: 'Move to Trash', hint: '⌘⌫' },
          ]
        : [
            { action: 'open', label: 'Open' },
            { action: 'open-default', label: 'Open in default app' },
            'divider',
            { action: 'add-chat', label: 'Add to chat' },
            { action: 'copy-path', label: 'Copy relative path' },
            { action: 'copy-absolute', label: 'Copy absolute path' },
            { action: 'reveal', label: 'Reveal in Finder' },
            'divider',
            { action: 'new-file', label: 'New file here' },
            { action: 'rename', label: 'Rename…', hint: 'F2' },
            { action: 'trash', label: 'Move to Trash', hint: '⌘⌫' },
          ],
  );
  let menu: HTMLDivElement;
  let left = $state(0);
  let top = $state(0);
  const buttons = () =>
    Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [],
    );
  function close(restore = true) {
    // Read the trigger before closing: the parent unmounts this menu on close.
    const target = returnFocus;
    onclose();
    if (restore && target?.isConnected) target.focus();
  }
  onMount(() => {
    // Keep the menu inside the window.
    const box = menu.getBoundingClientRect();
    left = Math.max(8, Math.min(x, innerWidth - box.width - 8));
    top = Math.max(8, Math.min(y, innerHeight - box.height - 8));
    tick().then(() => buttons()[0]?.focus());
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) close(false);
    };
    addEventListener('pointerdown', outside, true);
    return () => removeEventListener('pointerdown', outside, true);
  });
  function keys(event: KeyboardEvent) {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
</script>

<div
  class="tree-menu"
  role="menu"
  tabindex="-1"
  aria-label={entry ? `Actions for ${entry.name}` : 'Explorer actions'}
  bind:this={menu}
  style:left={`${left}px`}
  style:top={`${top}px`}
  onkeydown={keys}
>
  {#each items as item}
    {#if item === 'divider'}<div
        class="tree-menu-divider"
        role="separator"
      ></div>
    {:else}<button
        role="menuitem"
        class:danger={item.action === 'trash'}
        onclick={() => {
          // Run the action while the menu still knows its entry, then close.
          // Inline name fields and the Trash confirmation take focus themselves.
          const target = returnFocus;
          onaction(item.action);
          if (
            item.action !== 'rename' &&
            item.action !== 'new-file' &&
            item.action !== 'new-folder' &&
            item.action !== 'trash' &&
            target?.isConnected
          )
            target.focus();
          onclose();
        }}
        >{item.label}{#if item.hint}<kbd>{item.hint}</kbd>{/if}</button
      >{/if}
  {/each}
</div>

<style>
  .tree-menu {
    position: fixed;
    z-index: 120;
    min-width: 210px;
    padding: 5px;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    background: var(--glass-surface, var(--raised));
    backdrop-filter: var(--glass-blur, none);
    -webkit-backdrop-filter: var(--glass-blur, none);
    box-shadow: var(--shadow-pop);
    animation: menu-in 200ms var(--ease-spring, ease-out);
    transform-origin: top left;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
  }
  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-sm);
    text-align: left;
  }
  button:hover,
  button:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }
  button.danger {
    color: var(--red);
  }
  kbd {
    font-size: var(--fs-xs);
    background: transparent;
  }
  .tree-menu-divider {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }
</style>
