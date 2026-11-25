/**
 * Text inside one note: plain runs with inline marks, and thread mentions. On disk marks are
 * Markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[text](url)`, bare URLs) and a
 * mention is `[@title](t3://thread/<environmentId>/<threadId>)`.
 */

export interface NoteMarks {
  readonly bold?: true;
  readonly italic?: true;
  readonly strike?: true;
  readonly code?: true;
  readonly href?: string;
}

export type NoteMarkName = "bold" | "italic" | "strike" | "code";

/** Marks while being built; an undefined value turns a mark off. */
type MarksInput = { readonly [K in keyof NoteMarks]?: NoteMarks[K] | undefined };

export interface NoteTextSegment {
  readonly kind: "text";
  readonly text: string;
  readonly marks?: NoteMarks;
}

export interface NoteThreadSegment {
  readonly kind: "thread";
  readonly environmentId: string;
  readonly threadId: string;
  /** The title when the mention was written; the live title wins while the thread exists. */
  readonly title: string;
}

export type NoteSegment = NoteTextSegment | NoteThreadSegment;

/** Marks in one key order, so equal marks always serialize to equal keys. */
export function makeMarks(input: MarksInput | undefined): NoteMarks | undefined {
  if (!input) return undefined;
  const marks: { bold?: true; italic?: true; strike?: true; code?: true; href?: string } = {};
  if (input.bold) marks.bold = true;
  if (input.italic) marks.italic = true;
  if (input.strike) marks.strike = true;
  if (input.code) marks.code = true;
  if (input.href) marks.href = input.href;
  return Object.keys(marks).length === 0 ? undefined : marks;
}

function sameMarks(a: NoteMarks | undefined, b: NoteMarks | undefined): boolean {
  return (
    !!a?.bold === !!b?.bold &&
    !!a?.italic === !!b?.italic &&
    !!a?.strike === !!b?.strike &&
    !!a?.code === !!b?.code &&
    (a?.href ?? "") === (b?.href ?? "")
  );
}

function text(value: string, marks?: MarksInput): NoteTextSegment {
  const clean = makeMarks(marks);
  return clean ? { kind: "text", text: value, marks: clean } : { kind: "text", text: value };
}

function segmentLength(segment: NoteSegment): number {
  return segment.kind === "text" ? segment.text.length : 1;
}

export function segmentsLength(segments: ReadonlyArray<NoteSegment>): number {
  let total = 0;
  for (const segment of segments) total += segmentLength(segment);
  return total;
}

/** Merges adjacent text with equal marks and drops empty text. */
export function normalizeSegments(segments: ReadonlyArray<NoteSegment>): NoteSegment[] {
  const out: NoteSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      if (segment.text.length === 0) continue;
      const last = out.at(-1);
      if (last?.kind === "text" && sameMarks(last.marks, segment.marks)) {
        out[out.length - 1] = text(last.text + segment.text, last.marks);
        continue;
      }
      out.push(text(segment.text, segment.marks));
      continue;
    }
    out.push(segment);
  }
  return out;
}

export function splitSegments(
  segments: ReadonlyArray<NoteSegment>,
  offset: number,
): [NoteSegment[], NoteSegment[]] {
  const left: NoteSegment[] = [];
  const right: NoteSegment[] = [];
  let position = 0;
  for (const segment of segments) {
    const length = segmentLength(segment);
    if (position + length <= offset) left.push(segment);
    else if (position >= offset) right.push(segment);
    else if (segment.kind === "text") {
      const cut = offset - position;
      left.push(text(segment.text.slice(0, cut), segment.marks));
      right.push(text(segment.text.slice(cut), segment.marks));
    }
    position += length;
  }
  return [normalizeSegments(left), normalizeSegments(right)];
}

export function deleteRange(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
): NoteSegment[] {
  if (end <= start) return [...segments];
  const [left] = splitSegments(segments, start);
  const [, right] = splitSegments(segments, end);
  return normalizeSegments([...left, ...right]);
}

export function insertSegments(
  segments: ReadonlyArray<NoteSegment>,
  offset: number,
  inserted: ReadonlyArray<NoteSegment>,
): NoteSegment[] {
  const [left, right] = splitSegments(segments, offset);
  return normalizeSegments([...left, ...inserted, ...right]);
}

export function segmentsKey(segments: ReadonlyArray<NoteSegment>): string {
  return JSON.stringify(segments);
}

/** Applies `fn` to the text between `start` and `end`; mentions stay as they are. */
function mapRange(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
  fn: (marks: NoteMarks | undefined) => MarksInput,
): NoteSegment[] {
  const [left, rest] = splitSegments(segments, start);
  const [middle, right] = splitSegments(rest, end - start);
  const mapped = middle.map((segment) =>
    segment.kind === "text" ? text(segment.text, fn(segment.marks)) : segment,
  );
  return normalizeSegments([...left, ...mapped, ...right]);
}

function textInRange(segments: ReadonlyArray<NoteSegment>, start: number, end: number) {
  const [, rest] = splitSegments(segments, start);
  const [middle] = splitSegments(rest, end - start);
  return middle.filter((segment): segment is NoteTextSegment => segment.kind === "text");
}

export function rangeHasMark(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
  mark: NoteMarkName,
): boolean {
  const texts = textInRange(segments, start, end);
  return texts.length > 0 && texts.every((segment) => segment.marks?.[mark] === true);
}

/** Turns `mark` on for the range, or off when the whole range already has it. */
export function toggleMark(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
  mark: NoteMarkName,
): NoteSegment[] {
  const on = !rangeHasMark(segments, start, end, mark);
  return setMark(segments, start, end, mark, on);
}

export function setMark(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
  mark: NoteMarkName,
  on: boolean,
): NoteSegment[] {
  return mapRange(segments, start, end, (marks) => ({
    ...marks,
    [mark]: on ? true : undefined,
  }));
}

export function setLink(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
  href: string | null,
): NoteSegment[] {
  return mapRange(segments, start, end, (marks) => ({ ...marks, href: href ?? undefined }));
}

/** The link around `offset`, as a range and its address. */
export function linkAt(
  segments: ReadonlyArray<NoteSegment>,
  offset: number,
): { start: number; end: number; href: string } | null {
  const runs: Array<{ start: number; end: number; href: string }> = [];
  let position = 0;
  for (const segment of segments) {
    const length = segmentLength(segment);
    const href = segment.kind === "text" ? segment.marks?.href : undefined;
    const last = runs.at(-1);
    if (href && last?.href === href && last.end === position) last.end = position + length;
    else if (href) runs.push({ start: position, end: position + length, href });
    position += length;
  }
  return runs.find((run) => offset >= run.start && offset <= run.end) ?? null;
}

const THREAD_LINK = /\[@([^\]\n]*)\]\(t3:\/\/thread\/([^/\s)]+)\/([^/\s)]+)\)/g;
const LINK = /^\[((?:\\.|[^\]\\\n])+)\]\(([^()\s]+)\)/;
const URL = /^https?:\/\/[^\s<>　-〿一-鿿＀-￯]+/;
const URL_TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/;
const ESCAPABLE = new Set(["\\", "*", "_", "~", "`", "[", "]", "#", ">"]);
const WORD = /[A-Za-z0-9]/;

function threadLink(environmentId: string, threadId: string): string {
  return `t3://thread/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function runLength(source: string, index: number, char: string): number {
  let length = 0;
  while (source[index + length] === char) length += 1;
  return length;
}

/** The start of a closing delimiter run of `length` × `char`, aligned to the run's end. */
function findCloser(source: string, from: number, char: string, length: number): number {
  for (let index = from; index < source.length; index++) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] !== char) continue;
    const run = runLength(source, index, char);
    const before = source[index - 1];
    const after = source[index + run];
    const flanked =
      run >= length &&
      before !== undefined &&
      !/\s/.test(before) &&
      (char !== "_" || after === undefined || !WORD.test(after));
    if (flanked && index > from) return index + run - length;
    index += run - 1;
  }
  return -1;
}

const DELIMITERS: ReadonlyArray<{ char: string; length: number; marks: NoteMarks }> = [
  { char: "*", length: 3, marks: { bold: true, italic: true } },
  { char: "_", length: 3, marks: { bold: true, italic: true } },
  { char: "*", length: 2, marks: { bold: true } },
  { char: "_", length: 2, marks: { bold: true } },
  { char: "~", length: 2, marks: { strike: true } },
  { char: "*", length: 1, marks: { italic: true } },
  { char: "_", length: 1, marks: { italic: true } },
];

function parseMarkdown(source: string, marks: NoteMarks, autolink: boolean): NoteTextSegment[] {
  const out: NoteTextSegment[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push(text(buffer, marks));
    buffer = "";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const previous = source[index - 1];
    if (char === "\\" && ESCAPABLE.has(source[index + 1] ?? "")) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const run = runLength(source, index, "`");
      const close = source.indexOf("`".repeat(run), index + run);
      if (close > index + run && source[close + run] !== "`") {
        let code = source.slice(index + run, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        flush();
        out.push(text(code, { ...marks, code: true }));
        index = close + run;
        continue;
      }
      buffer += "`".repeat(run);
      index += run;
      continue;
    }
    if (char === "[") {
      const link = LINK.exec(source.slice(index));
      if (link) {
        flush();
        out.push(...parseMarkdown(link[1]!, { ...marks, href: link[2]! }, false));
        index += link[0].length;
        continue;
      }
    }
    if (autolink && char === "h" && (previous === undefined || !WORD.test(previous))) {
      const url = URL.exec(source.slice(index))?.[0].replace(URL_TRAILING_PUNCTUATION, "");
      if (url && url.length > "https://".length) {
        flush();
        out.push(text(url, { ...marks, href: url }));
        index += url.length;
        continue;
      }
    }
    if (char === "*" || char === "_" || char === "~") {
      const run = runLength(source, index, char);
      const next = source[index + run];
      const opens =
        next !== undefined &&
        !/\s/.test(next) &&
        (char !== "_" || previous === undefined || !WORD.test(previous));
      const delimiter = opens
        ? DELIMITERS.find((entry) => entry.char === char && entry.length === Math.min(run, 3))
        : undefined;
      const close = delimiter
        ? findCloser(source, index + delimiter.length, char, delimiter.length)
        : -1;
      if (delimiter && close > index + delimiter.length) {
        flush();
        out.push(
          ...parseMarkdown(
            source.slice(index + delimiter.length, close),
            { ...marks, ...delimiter.marks },
            autolink,
          ),
        );
        index = close + delimiter.length;
        continue;
      }
      buffer += char.repeat(run);
      index += run;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

export function parseInlineSegments(source: string): NoteSegment[] {
  const segments: NoteSegment[] = [];
  let last = 0;
  for (const match of source.matchAll(THREAD_LINK)) {
    const index = match.index ?? 0;
    if (index > last) segments.push(...parseMarkdown(source.slice(last, index), {}, true));
    segments.push({
      kind: "thread",
      title: match[1] ?? "",
      environmentId: safeDecode(match[2] ?? ""),
      threadId: safeDecode(match[3] ?? ""),
    });
    last = index + match[0].length;
  }
  if (last < source.length) segments.push(...parseMarkdown(source.slice(last), {}, true));
  return normalizeSegments(segments);
}

/** Escapes plain text only where it would otherwise read back as markup. */
function escapeText(value: string): string {
  const parsed = parseMarkdown(value, {}, false);
  if (
    parsed.length === 0 ||
    (parsed.length === 1 && parsed[0]!.text === value && !parsed[0]!.marks)
  )
    return value;
  return value.replace(/[\\*_~`[\]]/g, (char) => `\\${char}`);
}

function codeSpan(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return longest > 0 ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

const STACKED = ["strike", "bold", "italic"] as const;
type StackedMark = (typeof STACKED)[number];

/**
 * Italic is written `_x_` so it never runs into the `**` of bold beside it; inside a word, where
 * `_` does not count, it falls back to `*x*`.
 */
function delimiterFor(mark: StackedMark, before: string | undefined, after: string | undefined) {
  if (mark === "strike") return "~~";
  if (mark === "bold") return "**";
  return (before && WORD.test(before)) || (after && WORD.test(after)) ? "*" : "_";
}

/** Moves spaces at the edges of a marked run outside it; `** x**` would not read back as bold. */
function peelSpaces(segment: NoteTextSegment): NoteTextSegment[] {
  const { marks } = segment;
  if (!marks || !(marks.bold || marks.italic || marks.strike || marks.code)) return [segment];
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text)!;
  const outside = marks.href ? { href: marks.href } : undefined;
  return [text(match[1]!, outside), text(match[2]!, marks), text(match[3]!, outside)].filter(
    (part) => part.text.length > 0,
  );
}

function serializeMarked(segments: ReadonlyArray<NoteTextSegment>): string {
  let out = "";
  let open: Array<{ mark: StackedMark; delimiter: string }> = [];
  segments.forEach((segment, index) => {
    const want = STACKED.filter((mark) => segment.marks?.[mark]);
    let keep = 0;
    while (keep < open.length && keep < want.length && open[keep]!.mark === want[keep]) keep += 1;
    for (let level = open.length - 1; level >= keep; level--) out += open[level]!.delimiter;
    open = open.slice(0, keep);
    for (const mark of want.slice(keep)) {
      const runEnd = segments.slice(index + 1).findIndex((next) => !next.marks?.[mark]);
      const after = runEnd === -1 ? undefined : segments[index + 1 + runEnd];
      const delimiter = delimiterFor(mark, out.at(-1), after?.text[0]);
      out += delimiter;
      open.push({ mark, delimiter });
    }
    out += segment.marks?.code ? codeSpan(segment.text) : escapeText(segment.text);
  });
  for (let level = open.length - 1; level >= 0; level--) out += open[level]!.delimiter;
  return out;
}

export function serializeInline(
  segments: ReadonlyArray<NoteSegment>,
  mention: (segment: NoteThreadSegment) => string = (segment) =>
    `[@${segment.title.replace(/[[\]\n]/g, " ").trim()}](${threadLink(
      segment.environmentId,
      segment.threadId,
    )})`,
): string {
  let out = "";
  let group: NoteTextSegment[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const href = group[0]!.marks?.href;
    const inner = serializeMarked(group.flatMap(peelSpaces));
    const plain = group.map((segment) => segment.text).join("");
    const bare =
      href !== undefined &&
      plain === href &&
      group.every((segment) => Object.keys(segment.marks ?? {}).length === 1) &&
      URL.test(href);
    out += bare ? href : href === undefined ? inner : `[${inner}](${href})`;
    group = [];
  };
  for (const segment of segments) {
    if (segment.kind === "thread") {
      flush();
      out += mention(segment);
      continue;
    }
    if (group.length > 0 && group[0]!.marks?.href !== segment.marks?.href) flush();
    group.push(segment);
  }
  flush();
  return out;
}

const INLINE_SHORTCUTS: ReadonlyArray<{
  pattern: RegExp;
  marks: (match: RegExpExecArray) => NoteMarks;
}> = [
  { pattern: /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks: () => ({ bold: true }) },
  { pattern: /~~([^~\s](?:[^~]*[^~\s])?)~~$/, marks: () => ({ strike: true }) },
  { pattern: /`([^`]+)`$/, marks: () => ({ code: true }) },
  { pattern: /(?<![*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks: () => ({ italic: true }) },
  { pattern: /\[([^\]\n]+)\]\(([^()\s]+)\)$/, marks: (match) => ({ href: match[2]! }) },
];

/**
 * Markdown typed into a note takes effect as soon as its closing character lands, as in most
 * editors; a URL becomes a link once a space follows it.
 */
export function applyTypingShortcut(
  segments: ReadonlyArray<NoteSegment>,
  caret: number,
): { segments: NoteSegment[]; caret: number } | null {
  let position = 0;
  for (const segment of segments) {
    const length = segmentLength(segment);
    if (segment.kind === "text" && caret > position && caret <= position + length) {
      if (segment.marks?.code) return null;
      const before = segment.text.slice(0, caret - position);
      for (const shortcut of INLINE_SHORTCUTS) {
        const match = shortcut.pattern.exec(before);
        if (!match) continue;
        const start = position + match.index;
        const inner = text(match[1]!, { ...segment.marks, ...shortcut.marks(match) });
        return {
          segments: insertSegments(deleteRange(segments, start, caret), start, [inner]),
          caret: start + inner.text.length,
        };
      }
      const url = /(?:^|[^A-Za-z0-9])(https?:\/\/\S+)\s$/.exec(before);
      if (url && !segment.marks?.href) {
        const link = url[1]!.replace(URL_TRAILING_PUNCTUATION, "");
        const start = position + before.length - 1 - url[1]!.length;
        return link.length > "https://".length
          ? {
              segments: mapRange(segments, start, start + link.length, (marks) => ({
                ...marks,
                href: link,
              })),
              caret,
            }
          : null;
      }
      return null;
    }
    position += length;
  }
  return null;
}
