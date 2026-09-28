<script lang="ts">
  import type { FileMatch } from '../types';
  let {
    items,
    selected,
    searching,
    note,
    anchor,
    onpick,
    onhover,
  }: {
    items: FileMatch[];
    selected: number;
    searching: boolean;
    note: string;
    anchor: DOMRect;
    onpick: (item: FileMatch) => void;
    onhover: (index: number) => void;
  } = $props();
  // Highlight the characters the fuzzy search matched in the path.
  function parts(item: FileMatch) {
    const hits = new Set(item.indices ?? []);
    return [...item.path].map((char, i) => ({ char, hit: hits.has(i) }));
  }
</script>

<div
  class="mention-menu"
  style:left={`${anchor.left + 10}px`}
  style:bottom={`${innerHeight - anchor.top + 6}px`}
  style:width={`${Math.min(560, anchor.width - 20)}px`}
>
  <div class="mention-heading">
    <span>Files</span>
    <span class="muted"
      >{searching
        ? 'Searching project…'
        : note || '↑↓ choose · ↵ insert · esc'}</span
    >
  </div>
  <!-- Options are chosen from the composer (aria-activedescendant); the pointer can pick too. -->
  <div id="mention-list" role="listbox" aria-label="Files to mention">
    {#each items as item, index (item.path)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        id={`mention-option-${index}`}
        class="mention-option"
        role="option"
        tabindex="-1"
        aria-selected={index === selected}
        onpointermove={() => onhover(index)}
        onpointerdown={(event) => {
          // Keep focus (and the caret) in the composer.
          event.preventDefault();
          onpick(item);
        }}
      >
        <strong>{item.fileName || item.path.split('/').at(-1)}</strong>
        <span class="mention-path"
          >{#each parts(item) as part}{#if part.hit}<mark>{part.char}</mark
              >{:else}{part.char}{/if}{/each}</span
        >
      </div>
    {:else}
      <p class="mention-empty">
        {searching ? 'Searching project…' : 'No matching files'}
      </p>
    {/each}
  </div>
</div>

<style>
  .mention-menu {
    position: fixed;
    z-index: 70;
    max-height: 300px;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    background: var(--glass-surface, var(--raised));
    backdrop-filter: var(--glass-blur, none);
    -webkit-backdrop-filter: var(--glass-blur, none);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    animation: mention-in 200ms var(--ease-spring, ease-out);
    transform-origin: bottom left;
  }
  @keyframes mention-in {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.98);
    }
  }
  .mention-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 12px 5px;
    font-size: var(--fs-xs);
    font-weight: 600;
    border-bottom: 1px solid var(--line-soft);
  }
  .mention-heading .muted {
    font-weight: 400;
  }
  #mention-list {
    overflow: auto;
    padding: 4px;
  }
  .mention-option {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
    min-width: 0;
  }
  .mention-option[aria-selected='true'] {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .mention-option strong {
    flex-shrink: 0;
    font-size: var(--fs-sm);
    font-weight: 500;
  }
  .mention-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font: var(--fs-xs) var(--mono);
  }
  mark {
    background: none;
    color: var(--accent);
    font-weight: 700;
  }
  .mention-empty {
    margin: 0;
    padding: 10px;
    font-size: var(--fs-sm);
    color: var(--muted);
  }
</style>
