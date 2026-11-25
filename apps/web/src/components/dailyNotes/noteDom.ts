import { createMentionElement } from "./noteThreads";
import { makeMarks, type NoteMarks, type NoteSegment, normalizeSegments } from "./noteInline";

const TRAILING_BREAK = "data-trailing-break";

function isMention(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.mention === "thread";
}

const LINK_CLASS =
  "text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary";
const CODE_CLASS = "rounded-sm bg-foreground/7 px-1 py-px font-mono";

/** Inner to outer: code, italic, bold, strike, then the link around them all. */
function markedText(value: string, marks: NoteMarks | undefined): Node {
  let node: Node = document.createTextNode(value);
  const wrap = (tag: string, className?: string) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.append(node);
    node = element;
    return element;
  };
  if (marks?.code) wrap("code", CODE_CLASS).style.fontSize = "0.88em";
  if (marks?.italic) wrap("em");
  if (marks?.bold) wrap("strong", "font-semibold");
  if (marks?.strike) wrap("s");
  if (marks?.href) {
    const link = wrap("span", LINK_CLASS);
    link.dataset.href = marks.href;
    link.title = marks.href;
  }
  return node;
}

export function renderSegments(element: HTMLElement, segments: ReadonlyArray<NoteSegment>) {
  const children: Node[] = segments.map((segment) =>
    segment.kind === "text"
      ? markedText(segment.text, segment.marks)
      : createMentionElement(segment),
  );
  const last = segments.at(-1);
  // A trailing newline or a trailing mention needs a break so the caret has a line to sit on.
  if (last === undefined || last.kind === "thread" || last.text.endsWith("\n")) {
    const br = document.createElement("br");
    br.setAttribute(TRAILING_BREAK, "");
    children.push(br);
  }
  element.replaceChildren(...children);
}

export function readSegments(element: HTMLElement): NoteSegment[] {
  const segments: NoteSegment[] = [];
  const walk = (node: Node, isLast: boolean, marks: NoteMarks | undefined) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.textContent ?? "").replace(/​/g, "");
      const clean = makeMarks(marks);
      segments.push(
        clean ? { kind: "text", text: value, marks: clean } : { kind: "text", text: value },
      );
      return;
    }
    if (isMention(node)) {
      segments.push({
        kind: "thread",
        environmentId: node.dataset.environmentId ?? "",
        threadId: node.dataset.threadId ?? "",
        title: node.dataset.title ?? "",
      });
      return;
    }
    if (node instanceof HTMLBRElement) {
      // The last break only gives a trailing newline or an empty editor a line to show.
      if (!isLast) segments.push({ kind: "text", text: "\n" });
      return;
    }
    if (node instanceof HTMLElement) {
      const block = node.tagName === "DIV" || node.tagName === "P";
      if (block && segments.length > 0) segments.push({ kind: "text", text: "\n" });
      const tag = node.tagName;
      const inner: NoteMarks = {
        ...marks,
        ...(tag === "STRONG" || tag === "B" ? { bold: true } : {}),
        ...(tag === "EM" || tag === "I" ? { italic: true } : {}),
        ...(tag === "S" || tag === "DEL" || tag === "STRIKE" ? { strike: true } : {}),
        ...(tag === "CODE" ? { code: true } : {}),
        ...(node.dataset.href ? { href: node.dataset.href } : {}),
      };
      const kids = [...node.childNodes];
      kids.forEach((child, index) => walk(child, isLast && index === kids.length - 1, inner));
    }
  };
  const kids = [...element.childNodes];
  kids.forEach((child, index) => walk(child, index === kids.length - 1, undefined));
  return normalizeSegments(segments);
}

/** Zero-width text that only gives the caret a plain spot beside formatted text. */
const CARET_SLOT = "\u200b";

function visibleLength(value: string): number {
  return value.replaceAll(CARET_SLOT, "").length;
}

/** The DOM offset of model offset `offset` in `value`, past any caret slots there. */
function domOffsetIn(value: string, offset: number): number {
  let seen = 0;
  let index = 0;
  while (index < value.length && (seen < offset || value[index] === CARET_SLOT)) {
    if (value[index] !== CARET_SLOT) seen += 1;
    index += 1;
  }
  return index;
}

function isFormatted(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && !(node instanceof HTMLBRElement) && !isMention(node);
}

function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return visibleLength(node.textContent ?? "");
  if (isMention(node)) return 1;
  if (node instanceof HTMLBRElement) {
    return node.hasAttribute(TRAILING_BREAK) || node.nextSibling === null ? 0 : 1;
  }
  let total = 0;
  for (const child of node.childNodes) total += nodeLength(child);
  return total;
}

/** Model offset of a DOM position inside `root`. */
function offsetOf(root: HTMLElement, container: Node, domOffset: number): number {
  if (!root.contains(container)) return 0;
  let offset = 0;
  const visit = (node: Node): boolean => {
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += visibleLength((node.textContent ?? "").slice(0, domOffset));
      } else {
        const kids = [...node.childNodes].slice(0, domOffset);
        for (const kid of kids) offset += nodeLength(kid);
      }
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE || isMention(node) || node instanceof HTMLBRElement) {
      if (isMention(node) && node.contains(container)) {
        offset += 1;
        return true;
      }
      offset += nodeLength(node);
      return false;
    }
    for (const child of node.childNodes) if (visit(child)) return true;
    return false;
  };
  for (const child of root.childNodes) if (visit(child)) break;
  return offset;
}

export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * A caret spot in plain text at child `index` of `container`. Browsers type into the formatted
 * element beside a bare boundary, so one without plain text next to it gets a caret slot.
 */
function textSlot(container: Node, index: number): { node: Node; offset: number } {
  const before = container.childNodes[index - 1];
  if (before?.nodeType === Node.TEXT_NODE) {
    return { node: before, offset: (before.textContent ?? "").length };
  }
  const after = container.childNodes[index] ?? null;
  if (after?.nodeType === Node.TEXT_NODE) {
    return { node: after, offset: domOffsetIn(after.textContent ?? "", 0) };
  }
  const slot = document.createTextNode(CARET_SLOT);
  container.insertBefore(slot, after);
  return { node: slot, offset: 1 };
}

/** A boundary at the edge of formatted text lands outside it, so typing there is plain. */
function domPosition(root: Node, offset: number): { node: Node; offset: number } {
  let remaining = offset;
  const kids = [...root.childNodes];
  for (let index = 0; index < kids.length; index++) {
    const node = kids[index]!;
    const length = nodeLength(node);
    if (node.nodeType === Node.TEXT_NODE && remaining <= length) {
      return { node, offset: domOffsetIn(node.textContent ?? "", remaining) };
    }
    if (isFormatted(node) && remaining > 0 && remaining < length) {
      return domPosition(node, remaining);
    }
    if (remaining === 0 && isFormatted(node)) return textSlot(root, index);
    if (remaining < length || (remaining === 0 && length === 0)) {
      return { node: root, offset: index };
    }
    remaining -= length;
    if (remaining === 0 && node.nodeType !== Node.TEXT_NODE) {
      return isFormatted(node) ? textSlot(root, index + 1) : { node: root, offset: index + 1 };
    }
  }
  return {
    node: root,
    offset: kids.filter(
      (kid) => !(kid instanceof HTMLBRElement && kid.hasAttribute(TRAILING_BREAK)),
    ).length,
  };
}

export function setCaret(root: HTMLElement, start: number, end = start) {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const range = root.ownerDocument.createRange();
  const a = domPosition(root, start);
  range.setStart(a.node, a.offset);
  if (end !== start) {
    const b = domPosition(root, end);
    range.setEnd(b.node, b.offset);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretRect(root: HTMLElement): DOMRect | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  const rect = rects[0] ?? null;
  if (rect && (rect.height > 0 || rect.width > 0)) return rect;
  // Collapsed ranges at a line start can report nothing; measure a probe instead.
  const probe = document.createTextNode("​");
  range.insertNode(probe);
  const probeRange = document.createRange();
  probeRange.selectNode(probe);
  const probed = probeRange.getBoundingClientRect();
  probe.remove();
  root.normalize();
  return probed;
}

export function caretLineEdge(root: HTMLElement): { first: boolean; last: boolean; x: number } {
  const rect = caretRect(root);
  const box = root.getBoundingClientRect();
  if (!rect) return { first: true, last: true, x: box.left };
  const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 20;
  return {
    first: rect.top - box.top < lineHeight * 0.75,
    last: box.bottom - rect.bottom < lineHeight * 0.75,
    x: rect.left,
  };
}

/** Puts the caret on the first or last line of `root`, nearest to viewport x. */
export function placeCaretAtX(root: HTMLElement, x: number, edge: "top" | "bottom") {
  const box = root.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 20;
  const y = edge === "top" ? box.top + lineHeight / 2 : box.bottom - lineHeight / 2;
  const clampedX = Math.min(Math.max(x, box.left + 1), box.right - 1);
  const doc = root.ownerDocument;
  const position =
    "caretPositionFromPoint" in doc
      ? (
          doc as Document & {
            caretPositionFromPoint: (
              x: number,
              y: number,
            ) => { offsetNode: Node; offset: number } | null;
          }
        ).caretPositionFromPoint(clampedX, y)
      : null;
  const fallback = position ? null : doc.caretRangeFromPoint?.(clampedX, y);
  const node = position?.offsetNode ?? fallback?.startContainer;
  const offset = position?.offset ?? fallback?.startOffset ?? 0;
  if (node && root.contains(node)) {
    const model = offsetOf(root, node, offset);
    setCaret(root, model);
    return;
  }
  setCaret(root, edge === "top" ? 0 : nodeLength(root));
}
