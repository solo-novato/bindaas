import type { LaunchScope } from '../launcher';
import type { FileMatch } from '../types';

// Project file search for ⌘P and @ mentions. Codex's fuzzy search runs only while a
// query is typed (debounced, latest request wins); files the app already knows
// about are always available as an instant fallback.

/** Finds an `@query` token ending at the caret, if the caret is inside one. */
export function findMention(value: string, caret: number) {
  const match = /(^|\s)@([^\s@]{0,120})$/.exec(value.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

/** Case-insensitive substring matches among known file paths. */
export function matchKnownFiles(
  paths: Iterable<string>,
  query: string,
  limit = 8,
) {
  const text = query.toLowerCase();
  return [...new Set(paths)]
    .filter((path) => path.toLowerCase().includes(text))
    .slice(0, limit)
    .map((path): FileMatch => ({
      path,
      fileName: path.split('/').at(-1) ?? path,
      indices: null,
    }));
}

/** Debounced project search where only the newest request reports back. */
export class ProjectSearch {
  #sequence = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private search: (query: string) => Promise<FileMatch[] | null>,
    private enabled: () => boolean,
    private delay = 140,
  ) {}
  /** Calls `onresult` with matches, or null when search is unavailable. */
  run(query: string, onresult: (files: FileMatch[] | null) => void) {
    this.cancel();
    const sequence = this.#sequence;
    const text = query.trim();
    if (!this.enabled() || !text) return;
    this.#timer = setTimeout(async () => {
      try {
        const files = await this.search(text);
        if (sequence === this.#sequence) onresult(files ?? []);
      } catch {
        if (sequence === this.#sequence) onresult(null);
      }
    }, this.delay);
  }
  cancel() {
    clearTimeout(this.#timer);
    this.#sequence++;
  }
}

/** Project matches merged into the ⌘P / launcher Files results. */
export class LauncherSearch {
  matches = $state<FileMatch[]>([]);
  searching = $state(false);
  constructor(private search: ProjectSearch) {}
  query(query: string, scope: LaunchScope) {
    if (!query.trim() || scope === 'Actions' || scope === 'Tasks')
      return this.reset();
    this.searching = true;
    this.search.run(query, (files) => {
      this.searching = false;
      this.matches = files ?? [];
    });
  }
  reset() {
    this.search.cancel();
    this.matches = [];
    this.searching = false;
  }
}

/** The composer's @ mention menu. */
export class Mentions {
  active = $state<{ start: number; query: string; anchor: DOMRect } | null>(
    null,
  );
  items = $state<FileMatch[]>([]);
  selected = $state(0);
  searching = $state(false);
  note = $state('');
  constructor(
    private search: ProjectSearch,
    private knownFiles: () => string[],
  ) {}

  close() {
    this.active = null;
    this.items = [];
    this.searching = false;
    this.note = '';
  }

  /** Re-reads the caret position; opens, updates, or closes the menu. */
  update(field: HTMLTextAreaElement | undefined, enabled: boolean) {
    if (!field || !enabled) return this.close();
    const caret = field.selectionStart ?? 0;
    if (field.selectionEnd !== caret) return this.close();
    const found = findMention(field.value, caret);
    if (!found) return this.close();
    const changed = this.active?.query !== found.query;
    this.active = {
      ...found,
      anchor: field.closest('.composer-inner')!.getBoundingClientRect(),
    };
    if (!changed) return;
    const query = found.query;
    this.selected = 0;
    this.note = '';
    this.items = matchKnownFiles(this.knownFiles(), query);
    if (!query) {
      this.searching = false;
      return;
    }
    this.searching = true;
    this.search.run(query, (files) => {
      if (this.active?.query !== query) return;
      this.searching = false;
      if (files === null) {
        this.note = 'Showing files you have opened';
        return;
      }
      const seen = new Set(files.map((f) => f.path));
      this.items = [
        ...files,
        ...matchKnownFiles(this.knownFiles(), query).filter(
          (f) => !seen.has(f.path),
        ),
      ].slice(0, 12);
      this.selected = 0;
    });
  }

  /** Replaces the `@query` with `@path ` and returns the new text and caret. */
  insert(item: FileMatch, field: HTMLTextAreaElement) {
    if (!this.active) return null;
    const value = field.value;
    const caret = field.selectionStart ?? value.length;
    const text = `@${item.path} `;
    const next = {
      value: value.slice(0, this.active.start) + text + value.slice(caret),
      caret: this.active.start + text.length,
    };
    this.close();
    return next;
  }

  /**
   * Handles menu keys while it is open. Returns the item to insert for Enter/Tab,
   * true when the key was otherwise handled, and false to let the composer handle it.
   */
  keydown(event: KeyboardEvent): FileMatch | boolean {
    if (!this.active || event.isComposing) return false;
    const count = this.items.length;
    if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      this.selected =
        (this.selected + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      return true;
    }
    if (
      count &&
      (event.key === 'Enter' || event.key === 'Tab') &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      return this.items[this.selected];
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    return false;
  }
}
