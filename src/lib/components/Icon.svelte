<script module lang="ts">
  const paths = {
    workbench: [
      'M8 3.5h8a4.5 4.5 0 0 1 4.5 4.5v8a4.5 4.5 0 0 1-4.5 4.5H8A4.5 4.5 0 0 1 3.5 16V8A4.5 4.5 0 0 1 8 3.5Z',
      'm8 8.5 3.5 3.5L8 15.5M13.5 15.5H17',
    ],
    chat: [
      'M7 4.5h10a3.5 3.5 0 0 1 3.5 3.5v6a3.5 3.5 0 0 1-3.5 3.5H9l-5.5 3V8A3.5 3.5 0 0 1 7 4.5Z',
      'M8 9.5h8M8 13h5',
    ],
    files: [
      'M9 3.5h6l4.5 4.5v9A1.5 1.5 0 0 1 18 18.5H9A1.5 1.5 0 0 1 7.5 17V5A1.5 1.5 0 0 1 9 3.5ZM15 3.5V8h4.5',
      'M3.5 7.5V20A1.5 1.5 0 0 0 5 21.5h9',
    ],
    changes: [
      'M6 3.5h7l5 5V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5ZM13 3.5v5h5',
      'M8 12h6M11 9v6M8 18h6',
    ],
    history: ['M3.5 11a8.5 8.5 0 1 1 2.4 7M3.5 5v6H9', 'M12 7.5V12l3.5 2'],
    settings: [
      'M4 7h3M11 7h9M4 17h9M17 17h3',
      'M11 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM17 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
    ],
    search: ['M17.5 10.5a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM16 16l4.5 4.5'],
    'panel-left': [
      'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5ZM9 4.5v15',
    ],
    'panel-right': [
      'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5ZM15 4.5v15',
    ],
    plus: ['M12 5v14M5 12h14'],
    'chevron-down': ['m6.5 9 5.5 5.5L17.5 9'],
    'chevron-right': ['m9 6.5 5.5 5.5L9 17.5'],
    'arrow-up': ['M12 19V5m-6 6 6-6 6 6'],
    'arrow-right': ['M5 12h14m-6-6 6 6-6 6'],
    close: ['m6 6 12 12M18 6 6 18'],
    folder: [
      'M3.5 7V5.5A1.5 1.5 0 0 1 5 4h5l2 3h7A1.5 1.5 0 0 1 20.5 8.5v10A1.5 1.5 0 0 1 19 20H5A1.5 1.5 0 0 1 3.5 18.5V7Z',
    ],
    'folder-plus': [
      'M3.5 7V5.5A1.5 1.5 0 0 1 5 4h5l2 3h7A1.5 1.5 0 0 1 20.5 8.5v10A1.5 1.5 0 0 1 19 20H5A1.5 1.5 0 0 1 3.5 18.5V7Z',
      'M12 10.5v6M9 13.5h6',
    ],
    'file-plus': [
      'M6 3.5h7l5 5V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5ZM13 3.5v5h5',
      'M11.25 11v6M8.25 14h6',
    ],
    'folder-open': [
      'M3.5 11V5.5A1.5 1.5 0 0 1 5 4h5l2 3h7A1.5 1.5 0 0 1 20.5 8.5V11',
      'M5 20h14l2-9H3l2 9Z',
    ],
    file: [
      'M6 3.5h7l5 5V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5ZM13 3.5v5h5',
    ],
    code: ['m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16'],
    markdown: [
      'M4 5.5h16A1.5 1.5 0 0 1 21.5 7v10a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 17V7A1.5 1.5 0 0 1 4 5.5Z',
      'M6 15V9l3 3 3-3v6M17 9v6m-2-2 2 2 2-2',
    ],
    branch: [
      'M8 6.5v11M8 14h5a4 4 0 0 0 4-4V6.5',
      'M10.5 4a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19.5 4a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM10.5 20a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
    ],
    check: ['m5 12 4.5 4.5L19 7'],
    terminal: [
      'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5Z',
      'm7 9 3 3-3 3M13 15h4',
    ],
    focus: [
      'M8 3.5H5A1.5 1.5 0 0 0 3.5 5v3M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3',
      'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    ],
    paperclip: [
      'm20 11.5-8.1 8.1a5 5 0 0 1-7.1-7.1l8.3-8.3a3.25 3.25 0 0 1 4.6 4.6l-8.1 8.1a1.5 1.5 0 0 1-2.1-2.1L15 7.4',
    ],
    shield: [
      'm12 3.5 8 3v5c0 4.5-3 7.5-8 10-5-2.5-8-5.5-8-10v-5l8-3Z',
      'm8.5 12 2.5 2.5 4.5-5',
    ],
    refresh: [
      'M20.5 10A8.5 8.5 0 0 0 6 6L3.5 8.5M3.5 3.5v5h5M3.5 14A8.5 8.5 0 0 0 18 18l2.5-2.5M15.5 15.5h5v5',
    ],
  } satisfies Record<string, string[]>;

  export type IconName = keyof typeof paths;
</script>

<script lang="ts">
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="workbench-icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.65"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each paths[name] as d}<path {d} />{/each}
</svg>

<style>
  .workbench-icon {
    display: inline-block;
    flex: none;
    vertical-align: middle;
    pointer-events: none;
  }
</style>
