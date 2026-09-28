<script lang="ts">
  import Icon from './Icon.svelte';
  let {
    paths,
    current,
    blocked,
    onselect,
    onbrowse,
    onclose,
    returnFocus,
  }: {
    paths: string[];
    current: string | null;
    blocked: string;
    onselect: (path: string) => void;
    onbrowse: () => void;
    onclose: () => void;
    returnFocus?: HTMLElement;
  } = $props();
  let query = $state('');
  let selected = $state(0);
  let search: HTMLInputElement;
  let results: HTMLDivElement;
  const projects = $derived([
    ...new Set([...(current ? [current] : []), ...paths]),
  ]);
  const matches = $derived(
    projects.filter((path) =>
      path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ),
  );
  $effect(() => {
    query;
    selected = 0;
  });
  function mount(node: HTMLDialogElement) {
    const trigger =
      returnFocus ?? (document.activeElement as HTMLElement | null);
    node.showModal();
    search?.focus();
    return {
      destroy() {
        node.close();
        if (trigger?.isConnected) trigger.focus();
      },
    };
  }
  function choose(path: string) {
    if (path === current) onclose();
    else if (!blocked) onselect(path);
  }
  function keys(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!matches.length) return;
      selected =
        (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
        matches.length;
      results
        ?.querySelector(`#project-option-${selected}`)
        ?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (matches[selected]) choose(matches[selected]);
    }
  }
</script>

<dialog
  class="project-switcher"
  aria-label="Switch project"
  use:mount
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div class="project-switcher-content">
    <header>
      <div>
        <p class="eyebrow">WORKSPACES</p>
        <h2>Choose your project</h2>
        <p class="muted">Return to familiar work or open something new.</p>
      </div>
      <button aria-label="Close project switcher" onclick={onclose}
        ><Icon name="close" size={16} /></button
      >
    </header>
    <div class="project-switcher-search">
      <span aria-hidden="true"><Icon name="search" size={18} /></span><input
        bind:this={search}
        bind:value={query}
        onkeydown={keys}
        role="combobox"
        aria-label="Search recent projects"
        aria-controls="project-options"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={matches[selected]
          ? `project-option-${selected}`
          : undefined}
        placeholder="Search project names or paths…"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    {#if blocked}<p class="project-switcher-notice" role="status">
        {blocked}
      </p>{/if}
    <div
      class="project-switcher-results"
      id="project-options"
      role="listbox"
      aria-label="Recent projects"
      bind:this={results}
    >
      {#each matches as path, index}<button
          id={`project-option-${index}`}
          role="option"
          aria-selected={selected === index}
          aria-disabled={!!blocked && path !== current}
          class:highlighted={selected === index}
          tabindex="-1"
          onclick={() => choose(path)}
        >
          <span class="project-switcher-icon" aria-hidden="true"
            ><Icon name="folder" size={22} /></span
          ><span class="project-switcher-copy"
            ><strong>{path.split('/').filter(Boolean).at(-1) || path}</strong
            ><small>{path}</small></span
          >{#if path === current}<span class="project-current">Current</span
            >{:else}<Icon name="arrow-right" size={16} />{/if}
        </button>{:else}<p class="project-switcher-empty">
          {query
            ? 'No recent projects match this search.'
            : 'Your recent projects will appear here.'}
        </p>{/each}
    </div>
    <footer>
      <span><kbd>↑</kbd> <kbd>↓</kbd> to choose · <kbd>↵</kbd> to open</span
      ><button class="primary" disabled={!!blocked} onclick={onbrowse}
        >Open another folder…</button
      >
    </footer>
  </div>
</dialog>
