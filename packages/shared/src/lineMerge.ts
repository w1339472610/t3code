/** Past this many compared pairs the diff gives up on finding matches and treats the middle as changed. */
const MAX_CELLS = 4_000_000;

/**
 * For each item of `a`, the index of the item of `b` it matches in a longest
 * common subsequence, or -1. Matches only ever increase.
 */
export function matchSequences(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Int32Array {
  const matches = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    matches[start] = start;
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    matches[endA] = endB;
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows === 0 || cols === 0 || rows * cols > MAX_CELLS) return matches;
  // lengths[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const width = cols + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[start + i] === b[start + j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[start + i] === b[start + j]) {
      matches[start + i] = start + j;
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

function sameLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** A side's change: base lines [start, end) became `lines`. */
interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: ReadonlyArray<string>;
}

function hunksOf(base: ReadonlyArray<string>, side: ReadonlyArray<string>): Hunk[] {
  const toSide = matchSequences(base, side);
  const hunks: Hunk[] = [];
  let b = 0;
  let s = 0;
  while (b <= base.length) {
    let next = b;
    while (next < base.length && toSide[next]! < 0) next += 1;
    const sideEnd = next < base.length ? toSide[next]! : side.length;
    if (next > b || sideEnd > s) hunks.push({ start: b, end: next, lines: side.slice(s, sideEnd) });
    b = next + 1;
    s = sideEnd + 1;
  }
  return hunks;
}

function applyWithin(base: ReadonlyArray<string>, start: number, end: number, hunks: Hunk[]) {
  const lines: string[] = [];
  let at = start;
  for (const hunk of hunks) {
    lines.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  lines.push(...base.slice(at, end));
  return lines;
}

/**
 * Three-way merge by line, for two writers editing copies of `base`. Changes
 * to different lines both land, even next to each other. Where both changed
 * the same lines, ours come first, then their lines ours lack; nothing either
 * side wrote is dropped.
 */
export function mergeLines(base: string, ours: string, theirs: string): string {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const baseLines = base.split("\n");
  const tagged = [
    ...hunksOf(baseLines, ours.split("\n")).map((hunk) => ({ hunk, ours: true })),
    ...hunksOf(baseLines, theirs.split("\n")).map((hunk) => ({ hunk, ours: false })),
  ].sort((a, b) => a.hunk.start - b.hunk.start || a.hunk.end - b.hunk.end);
  const merged: string[] = [];
  let at = 0;
  for (let index = 0; index < tagged.length;) {
    const first = tagged[index]!.hunk;
    let end = first.end;
    let last = index + 1;
    // Same-side hunks never overlap; insertions at one point, or overlapping ranges, from both sides do.
    while (last < tagged.length) {
      const next = tagged[last]!.hunk;
      const overlaps =
        next.start < end ||
        (next.start === first.start && next.start === next.end && first.start === first.end);
      if (!overlaps) break;
      end = Math.max(end, next.end);
      last += 1;
    }
    const cluster = tagged.slice(index, last);
    const start = first.start;
    const baseChunk = baseLines.slice(start, end);
    const side = (mine: boolean) =>
      applyWithin(
        baseLines,
        start,
        end,
        cluster.filter((entry) => entry.ours === mine).map((entry) => entry.hunk),
      );
    const ourChunk = side(true);
    const theirChunk = side(false);
    merged.push(...baseLines.slice(at, start));
    if (sameLines(ourChunk, baseChunk)) merged.push(...theirChunk);
    else if (sameLines(theirChunk, baseChunk) || sameLines(ourChunk, theirChunk))
      merged.push(...ourChunk);
    else {
      const kept = new Set(ourChunk);
      merged.push(...ourChunk, ...theirChunk.filter((line) => !kept.has(line)));
    }
    at = end;
    index = last;
  }
  merged.push(...baseLines.slice(at));
  return merged.join("\n");
}
