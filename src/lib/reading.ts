// Transient navigation only. Messages and Codex settings remain server-owned.
export type ReadingPosition = {
  top: number;
  anchor: string | null;
  offset: number;
  following: boolean;
};
export type ReadingView = ReadingPosition & {
  windowSize: number;
  expanded: string[];
  expandedGroups: string[];
};
export function capturePosition(
  node: HTMLElement,
  following: boolean,
): ReadingPosition {
  const top = node.getBoundingClientRect().top;
  const anchor = Array.from(
    node.querySelectorAll<HTMLElement>('[data-reading-key]'),
  ).find((row) => row.getBoundingClientRect().bottom > top + 1);
  return {
    top: node.scrollTop,
    anchor: anchor?.dataset.readingKey ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
    following,
  };
}
export function positionTop(
  node: HTMLElement,
  position: ReadingPosition,
): number {
  if (position.following) return node.scrollHeight;
  const anchor = Array.from(
    node.querySelectorAll<HTMLElement>('[data-reading-key]'),
  ).find((row) => row.dataset.readingKey === position.anchor);
  return anchor
    ? node.scrollTop +
        anchor.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        position.offset
    : position.top;
}
export class ReadingViews {
  private entries = new Map<string, ReadingView>();
  get(key: string) {
    return this.entries.get(key);
  }
  set(key: string, view: ReadingView) {
    this.entries.delete(key);
    this.entries.set(key, {
      ...view,
      windowSize: Math.min(400, view.windowSize),
      expanded: view.expanded.slice(-400),
      expandedGroups: view.expandedGroups.slice(-400),
    });
    if (this.entries.size > 20)
      this.entries.delete(this.entries.keys().next().value!);
  }
  follow(key: string) {
    const view = this.entries.get(key);
    if (view)
      this.set(key, {
        ...view,
        following: true,
        anchor: null,
        top: 0,
        offset: 0,
      });
  }
  clear() {
    this.entries.clear();
  }
}
