export type DiffFile = {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  start: number;
  end: number;
};
// Decode Git's quoted C-style paths (including UTF-8 octal byte escapes).
export function gitPath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const bytes: number[] = [];
    const inner = raw.slice(1, -1);
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\') {
        const oct = inner.slice(i + 1).match(/^[0-7]{1,3}/);
        if (oct) {
          bytes.push(parseInt(oct[0], 8));
          i += oct[0].length;
        } else {
          const ch = inner[++i];
          bytes.push(
            ...new TextEncoder().encode(
              ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[ch] ??
                ch,
            ),
          );
        }
      } else {
        const cp = inner.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        bytes.push(...new TextEncoder().encode(ch));
        if (cp > 65535) i++;
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  return raw;
}
const clean = (path: string) =>
  gitPath(path.split('\t')[0]).replace(/^[ab]\//, '');
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let offset = 0;
  let hunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) current.end = offset;
      const match = line.match(
        /^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/,
      );
      current = {
        path: match ? clean(match[2]) : 'Unknown path',
        status: 'modified',
        additions: 0,
        deletions: 0,
        start: offset,
        end: text.length,
      };
      files.push(current);
      hunk = false;
    }
    if (current) {
      if (!hunk && line.startsWith('--- ')) {
        current.oldPath = clean(line.slice(4));
        if (line.slice(4) === '/dev/null') current.status = 'added';
      } else if (!hunk && line.startsWith('+++ ')) {
        if (line.slice(4) === '/dev/null') {
          current.status = 'deleted';
          current.path = current.oldPath ?? current.path;
        } else current.path = clean(line.slice(4));
      } else if (line.startsWith('rename to ')) {
        current.status = 'renamed';
        current.path = gitPath(line.slice(10));
      } else if (line.startsWith('@@')) hunk = true;
      else if (hunk && line.startsWith('+')) current.additions++;
      else if (hunk && line.startsWith('-')) current.deletions++;
    }
    offset += line.length + 1;
  }
  return files;
}
export type DiffLine = {
  text: string;
  kind: string;
  old: number | null;
  next: number | null;
};
export type DiffHunk = {
  header: string;
  start: number;
  end: number;
  row: number;
  oldStart: number;
  oldCount: number;
  nextStart: number;
  nextCount: number;
};
// Offsets retain the exact patch (including no-newline markers) for follow-ups.
export function diffHunks(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let offset = 0;
  for (const [row, line] of text.split('\n').entries()) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      if (hunks.length) hunks[hunks.length - 1].end = offset;
      hunks.push({
        header: line,
        start: offset,
        end: text.length,
        row,
        oldStart: +match[1],
        oldCount: +(match[2] ?? 1),
        nextStart: +match[3],
        nextCount: +(match[4] ?? 1),
      });
    }
    offset += line.length + 1;
  }
  return hunks;
}
export function diffLines(text: string): DiffLine[] {
  let old = 0,
    next = 0;
  return text.split('\n').map((text) => {
    const m = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      old = +m[1];
      next = +m[2];
      return { text, kind: 'hunk', old: null, next: null };
    }
    if ((!old && !next) || text.startsWith('\\') || text === '')
      return { text, kind: 'meta', old: null, next: null };
    if (text.startsWith('+'))
      return { text: text.slice(1), kind: 'add', old: null, next: next++ };
    if (text.startsWith('-'))
      return { text: text.slice(1), kind: 'delete', old: old++, next: null };
    return { text: text.slice(1), kind: 'context', old: old++, next: next++ };
  });
}
