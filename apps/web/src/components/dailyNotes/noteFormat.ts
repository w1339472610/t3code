import { readLocalApi } from "~/localApi";
import { editDay, readDayTree, requestFocus } from "./dailyNotesStore";
import { getSelectionOffsets } from "./noteDom";
import { linkAt, type NoteMarkName, setLink, toggleMark } from "./noteInline";
import { locate, updateNode } from "./noteModel";

export interface NoteRange {
  readonly date: string;
  readonly nodeId: string;
  readonly start: number;
  readonly end: number;
}

/** The selected text of a note editor, or null when nothing is selected in it. */
export function selectedRange(element: HTMLElement): NoteRange | null {
  const offsets = getSelectionOffsets(element);
  const date = element.dataset.date;
  const nodeId = element.dataset.nodeId;
  if (!offsets || !date || !nodeId) return null;
  return { date, nodeId, start: offsets.start, end: offsets.end };
}

export function toggleRangeMark(range: NoteRange, mark: NoteMarkName) {
  editDay(
    range.date,
    (tree) =>
      updateNode(tree, range.nodeId, (node) => ({
        ...node,
        segments: toggleMark(node.segments, range.start, range.end, mark),
      })),
    { caret: { id: range.nodeId, offset: range.start } },
  );
  requestFocus(range.date, range.nodeId, range.start, range.end);
}

export function setRangeLink(range: NoteRange, href: string | null) {
  editDay(
    range.date,
    (tree) =>
      updateNode(tree, range.nodeId, (node) => ({
        ...node,
        segments: setLink(node.segments, range.start, range.end, href),
      })),
    { caret: { id: range.nodeId, offset: range.start } },
  );
  requestFocus(range.date, range.nodeId, range.end);
}

/** The link the caret sits in, widened to the whole link. */
export function linkRangeAt(date: string, nodeId: string, offset: number) {
  const node = locate(readDayTree(date) ?? [], nodeId)?.node;
  const link = node ? linkAt(node.segments, offset) : null;
  return link ? { date, nodeId, start: link.start, end: link.end, href: link.href } : null;
}

/** Adds a scheme to addresses typed without one; refuses anything that is not a web or mail link. */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  return /^(https?:|mailto:)/i.test(withScheme) ? withScheme : null;
}

export function openNoteLink(href: string) {
  const safe = normalizeHref(href);
  if (!safe) return;
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(safe).catch(() => window.open(safe, "_blank", "noopener"));
    return;
  }
  window.open(safe, "_blank", "noopener");
}
