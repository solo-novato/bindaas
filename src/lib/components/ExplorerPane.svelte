<script lang="ts">
  // Project explorer: header actions, the lazy file tree, and its empty state.
  import Icon from './Icon.svelte';
  import Tree from './Tree.svelte';
  import type { TreeAction } from './TreeMenu.svelte';
  import type { Entry, Project } from '../types';
  let {
    project,
    treeVersion,
    showHidden = $bindable(),
    changed,
    expanded,
    note,
    oncreate,
    onrefresh,
    oncollapse,
    onopenproject,
    ontoggle,
    onopen,
    ondiscover,
    onmenu,
    onaction,
    oncommit,
  }: {
    project: Project | null;
    treeVersion: number;
    showHidden: boolean;
    changed: string[];
    expanded: string[];
    note: string;
    oncreate: (directory: boolean) => void;
    onrefresh: () => void;
    oncollapse: () => void;
    onopenproject: () => void;
    ontoggle: (path: string) => void;
    onopen: (path: string) => void;
    ondiscover: (entries: Entry[]) => void;
    onmenu: (
      entry: Entry | null,
      x: number,
      y: number,
      trigger: HTMLElement | null,
    ) => void;
    onaction: (entry: Entry, action: TreeAction) => void;
    oncommit: (name: string) => void;
  } = $props();
</script>

<aside id="project-explorer" aria-label="Project explorer" class="project-pane">
  <div class="pane-heading">
    <span>Explorer</span>
    <div>
      <button
        title="New file"
        aria-label="New file"
        disabled={!project}
        onclick={() => oncreate(false)}
        ><Icon name="file-plus" size={15} /></button
      ><button
        title="New folder"
        aria-label="New folder"
        disabled={!project}
        onclick={() => oncreate(true)}
        ><Icon name="folder-plus" size={15} /></button
      ><button
        title="Refresh expanded tree"
        aria-label="Refresh file tree"
        disabled={!project}
        onclick={onrefresh}><Icon name="refresh" size={14} /></button
      ><button aria-label="Collapse explorer" onclick={oncollapse}
        ><Icon name="panel-left" size={15} /></button
      >
    </div>
  </div>
  {#if project}<div class="project-root" title={project.root}>
      <Icon name="folder" size={14} />
      {project.displayName}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions (Right-click on empty space; the same actions are the header buttons.) -->
    <div
      class="tree"
      oncontextmenu={(event) => {
        if ((event.target as HTMLElement).closest('.tree-item, input')) return;
        event.preventDefault();
        onmenu(null, event.clientX, event.clientY, null);
      }}
    >
      {#key `${project.root}:${treeVersion}`}<Tree
          {showHidden}
          {changed}
          {expanded}
          {ontoggle}
          {onopen}
          {ondiscover}
          {onmenu}
          {onaction}
          {oncommit}
        />{/key}
    </div>
    {#if note}<p class="explorer-note" role="status">
        {note}
      </p>{/if}
    <button class="tree-footer" onclick={() => (showHidden = !showHidden)}
      >{showHidden
        ? 'Hide hidden / generated'
        : 'Show hidden / generated'}</button
    >{:else}<div class="tree-empty">
      <p>No folder open</p>
      <button onclick={onopenproject}
        ><Icon name="folder" size={13} /> Open folder</button
      >
    </div>{/if}
</aside>
