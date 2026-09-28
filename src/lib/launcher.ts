export type LaunchScope = 'All' | 'Actions' | 'Tasks' | 'Files';
export type LaunchEntry = {
  id: string;
  title: string;
  detail: string;
  group: Exclude<LaunchScope, 'All'>;
  icon: string;
  shortcut?: string;
  keywords?: string;
  disabled?: boolean;
  attention?: boolean;
  /** Already matched by project search; skip local word filtering. */
  matched?: boolean;
  run: () => void | Promise<void>;
};

// Local, bounded matching. Opening the launcher never crawls the project; typed
// file queries may add Codex project-search results, marked `matched`.
export function rankEntries(
  entries: LaunchEntry[],
  query: string,
  scope: LaunchScope,
) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => scope === 'All' || entry.group === scope)
    .map((entry, order) => {
      const title = entry.title.toLowerCase();
      const text =
        `${title} ${entry.detail} ${entry.keywords ?? ''}`.toLowerCase();
      if (!entry.matched && !words.every((word) => text.includes(word)))
        return null;
      const score = words.reduce(
        (n, word) =>
          n + (title.startsWith(word) ? 5 : title.includes(word) ? 2 : 0),
        0,
      );
      return { entry, order, score };
    })
    .filter((match): match is NonNullable<typeof match> => match !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 60)
    .map(({ entry }) => entry);
}
