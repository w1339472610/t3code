import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "~/lib/utils";
import {
  clearFocusRequest,
  editDay,
  requestFocus,
  setBlockSelection,
  setEditingDate,
  undoDay,
  useDailyNotesStore,
} from "./dailyNotesStore";
import {
  closeMentionPicker,
  moveMentionHighlight,
  openMentionPicker,
  useMentionPickerStore,
} from "./mentionPickerStore";
import {
  caretLineEdge,
  getSelectionOffsets,
  placeCaretAtX,
  readSegments,
  renderSegments,
  setCaret,
} from "./noteDom";
import {
  cycleTodo,
  deleteRange,
  indentNode,
  insertAfter,
  insertNodes,
  insertSegments,
  locate,
  makeNode,
  moveAmongSiblings,
  type NoteNode,
  type NoteSegment,
  type NoteStyle,
  type NoteTree,
  normalizeSegments,
  outdentNode,
  parseInlineSegments,
  parseNote,
  removeNode,
  segmentsKey,
  segmentsLength,
  setCollapsed,
  splitSegments,
  updateNode,
  visibleRows,
} from "./noteModel";
import { linkRangeAt, openNoteLink, selectedRange, toggleRangeMark } from "./noteFormat";
import {
  applyTypingShortcut,
  linkAt,
  type NoteMarkName,
  rangeHasMark,
  setLink,
  setMark,
} from "./noteInline";
import { paintMention, resolveMention, useNoteThreadIndex } from "./noteThreads";

/** compact: month cells; document: the continuous document, set like body text. */
export type NoteDensity = "normal" | "compact" | "document";

const INDENT_PX: Record<NoteDensity, number> = { normal: 22, compact: 14, document: 32 };

/** Text size of a line, and the height its bullet, fold arrow and checkbox line up with. */
const LINE_LOOK: Record<NoteDensity, Record<NoteStyle, { text: string; height: string }>> = {
  normal: {
    text: { text: "min-h-6 text-sm/5", height: "h-6" },
    ordered: { text: "min-h-6 text-sm/5", height: "h-6" },
    quote: { text: "min-h-6 text-sm/5", height: "h-6" },
    h1: { text: "min-h-9 text-xl/8 font-semibold", height: "h-9" },
    h2: { text: "min-h-8 text-lg/7 font-semibold", height: "h-8" },
    h3: { text: "min-h-7 text-base/6 font-semibold", height: "h-7" },
  },
  document: {
    text: { text: "min-h-7 text-base/6", height: "h-7" },
    ordered: { text: "min-h-7 text-base/6", height: "h-7" },
    quote: { text: "min-h-7 text-base/6", height: "h-7" },
    h1: { text: "min-h-10 text-2xl/9 font-semibold", height: "h-10" },
    h2: { text: "min-h-9 text-xl/8 font-semibold", height: "h-9" },
    h3: { text: "min-h-8 text-lg/7 font-semibold", height: "h-8" },
  },
  compact: {
    text: { text: "min-h-5 text-xs/[18px]", height: "h-5" },
    ordered: { text: "min-h-5 text-xs/[18px]", height: "h-5" },
    quote: { text: "min-h-5 text-xs/[18px]", height: "h-5" },
    h1: { text: "min-h-5 text-xs/[18px] font-semibold", height: "h-5" },
    h2: { text: "min-h-5 text-xs/[18px] font-semibold", height: "h-5" },
    h3: { text: "min-h-5 text-xs/[18px] font-semibold", height: "h-5" },
  },
};

/** Typed at the start of a plain line, these change what kind of line it is. */
const STYLE_PREFIXES: ReadonlyArray<{
  pattern: RegExp;
  style: (match: RegExpExecArray) => NoteStyle;
}> = [
  {
    pattern: /^(#{1,3})[ \u3000]/,
    style: (match) => (["h1", "h2", "h3"] as const)[match[1]!.length - 1]!,
  },
  { pattern: /^\d{1,3}[.．、][ \u3000]/, style: () => "ordered" },
  { pattern: /^[>》][ \u3000]/, style: () => "quote" },
];

export function indentFor(density: NoteDensity): number {
  return INDENT_PX[density];
}

/** Typed at the start of a line, these turn it into a to-do; IMEs give the full-width brackets. */
const TODO_PREFIX = /^(?:\[ ?\]|【 ?】|\[[xX]\]|【[xX]】)[ \u3000]/;

export interface NotesViewApi {
  /** Rows of every rendered day in document order, for moving the caret across days. */
  readonly rowTexts: () => HTMLElement[];
  readonly openThread: (environmentId: string, threadId: string) => void;
  readonly startBulletDrag: (
    event: ReactPointerEvent<HTMLElement>,
    date: string,
    nodeId: string,
  ) => void;
  readonly chooseMention: () => boolean;
  readonly mentionCount: () => number;
  /** Opens the link editor for a range of a note; `href` is the link it already has. */
  readonly editLink: (
    range: { date: string; nodeId: string; start: number; end: number },
    href: string,
  ) => void;
  readonly focusSelectionHost: () => void;
}

export const NotesViewContext = createContext<NotesViewApi | null>(null);

function useNotesView(): NotesViewApi {
  const api = useContext(NotesViewContext);
  if (!api) throw new Error("NotesViewContext is missing");
  return api;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
function isMod(event: { metaKey: boolean; ctrlKey: boolean }) {
  return isMac ? event.metaKey : event.ctrlKey;
}

function sameSegments(a: ReadonlyArray<NoteSegment>, b: ReadonlyArray<NoteSegment>) {
  return a === b || segmentsKey(a) === segmentsKey(b);
}

function previousVisible(tree: NoteTree, id: string): NoteNode | null {
  const rows = visibleRows(tree);
  const index = rows.findIndex((row) => row.node.id === id);
  return index > 0 ? rows[index - 1]!.node : null;
}

function nextVisible(tree: NoteTree, id: string): NoteNode | null {
  const rows = visibleRows(tree);
  const index = rows.findIndex((row) => row.node.id === id);
  return index >= 0 && index < rows.length - 1 ? rows[index + 1]!.node : null;
}

/** Joins `node` onto the end of `target`; children go where they stay visible. */
function mergeInto(tree: NoteTree, targetId: string, nodeId: string): NoteTree | null {
  const nodeLocation = locate(tree, nodeId);
  const target = locate(tree, targetId)?.node;
  if (!nodeLocation || !target) return null;
  const { node } = nodeLocation;
  let next = removeNode(tree, nodeId);
  if (nodeLocation.parentId === targetId) {
    next = insertNodes(next, targetId, nodeLocation.index, node.children);
    next = updateNode(next, targetId, (current) => ({
      ...current,
      segments: normalizeSegments([...current.segments, ...node.segments]),
    }));
  } else {
    next = updateNode(next, targetId, (current) => ({
      ...current,
      segments: normalizeSegments([...current.segments, ...node.segments]),
      children: [...current.children, ...node.children],
    }));
  }
  return next;
}

function NoteTextImpl(props: {
  readonly date: string;
  readonly node: NoteNode;
  readonly placeholder: string | null;
  readonly density: NoteDensity;
}) {
  const { date, node } = props;
  const gt = useGT();
  const view = useNotesView();
  const threads = useNoteThreadIndex();
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<ReadonlyArray<NoteSegment> | null>(null);
  const focus = useDailyNotesStore((state) =>
    state.focus?.date === date && state.focus.nodeId === node.id ? state.focus : null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the editable DOM is owned imperatively; this mirrors model changes (undo, merges, remote edits) into it and repaints live mention status
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (shown.current !== node.segments) {
      if (!sameSegments(readSegments(element), node.segments) || shown.current === null) {
        const caret =
          element.ownerDocument.activeElement === element ? getSelectionOffsets(element) : null;
        renderSegments(element, node.segments);
        if (caret) setCaret(element, Math.min(caret.start, segmentsLength(node.segments)));
      }
      shown.current = node.segments;
    }
    for (const mention of element.querySelectorAll<HTMLElement>("[data-mention]")) {
      paintMention(
        mention,
        resolveMention(threads, {
          kind: "thread",
          environmentId: mention.dataset.environmentId ?? "",
          threadId: mention.dataset.threadId ?? "",
          title: mention.dataset.title ?? "",
        }),
      );
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves browser focus and the caret, which live outside React
  useLayoutEffect(() => {
    const element = ref.current;
    if (!focus || !element) return;
    element.focus({ preventScroll: true });
    const length = segmentsLength(node.segments);
    const start =
      focus.offset === "end"
        ? length
        : focus.offset === "start"
          ? 0
          : Math.min(focus.offset, length);
    setCaret(element, start, focus.end === undefined ? start : Math.min(focus.end, length));
    element.scrollIntoView({ block: "nearest" });
    clearFocusRequest(focus.nonce);
  }, [focus, node.segments]);

  const caretBefore = (adjust = 0) => ({
    id: node.id,
    offset: Math.max(0, (ref.current ? getSelectionOffsets(ref.current)?.start : 0) ?? 0) + adjust,
  });

  const edit = (
    update: (tree: NoteTree) => NoteTree | null,
    coalesceKey?: string,
    caret = caretBefore(),
  ) => editDay(date, update, { caret, ...(coalesceKey ? { coalesceKey } : {}) });

  const restore = (direction: "undo" | "redo") => {
    const caret = undoDay(date, direction);
    if (caret) requestFocus(date, caret.id, caret.offset);
  };

  const offsets = () => {
    const element = ref.current!;
    return (
      getSelectionOffsets(element) ?? {
        start: segmentsLength(node.segments),
        end: segmentsLength(node.segments),
      }
    );
  };

  /** Marks chosen with the caret collapsed; they apply to what is typed next. */
  const pending = useRef<Partial<Record<NoteMarkName, boolean>> | null>(null);
  const compositionStart = useRef<{ offset: number; atLinkEnd: boolean } | null>(null);

  const format = (mark: NoteMarkName) => {
    const range = selectedRange(ref.current!);
    if (!range) return;
    if (range.start !== range.end) {
      toggleRangeMark(range, mark);
      return;
    }
    const active =
      pending.current?.[mark] ??
      (range.start > 0 && rangeHasMark(node.segments, range.start - 1, range.start, mark));
    pending.current = { ...pending.current, [mark]: !active };
  };

  /** Typing at the end of a link writes after it; links do not grow the way bold text does. */
  const endsLink = (offset: number) => linkAt(node.segments, offset)?.end === offset;
  const keepLinkEnd = (segments: NoteSegment[], start: number, end: number, atLinkEnd: boolean) =>
    atLinkEnd && end > start ? setLink(segments, start, end, null) : segments;

  const applyPending = (segments: NoteSegment[], start: number, end: number) => {
    let next = segments;
    for (const [mark, on] of Object.entries(pending.current ?? {}))
      next = setMark(next, start, end, mark as NoteMarkName, on);
    return next;
  };

  const setStyle = (style: NoteStyle) => {
    edit((tree) =>
      updateNode(tree, node.id, (current) => ({
        ...current,
        style: current.style === style ? "text" : style,
      })),
    );
  };

  const syncPicker = (segments: ReadonlyArray<NoteSegment>, caret: number) => {
    const text = segments.map((s) => (s.kind === "text" ? s.text : "￼")).join("");
    const picker = useMentionPickerStore.getState().picker;
    const opened = (() => {
      const before = text[caret - 1];
      const prior = text[caret - 2];
      if ((before === "@" || before === "＠") && (prior === undefined || /[\s￼([（]/.test(prior)))
        return { start: caret - 1, kind: "mention" as const };
      // A Chinese input method types `、` for the slash key; only a line start takes it.
      if (
        (before === "/" && (prior === undefined || /\s/.test(prior))) ||
        (before === "、" && caret === 1)
      )
        return { start: caret - 1, kind: "slash" as const };
      return null;
    })();
    const current =
      picker && picker.nodeId === node.id ? { start: picker.start, kind: picker.kind } : opened;
    if (current === null) return;
    const { start, kind } = current;
    const query = text.slice(start + 1, caret);
    const trigger = kind === "mention" ? ["@", "＠"] : ["/", "、"];
    if (
      caret <= start ||
      !trigger.includes(text[start] ?? "") ||
      /[\n￼]/.test(query) ||
      (kind === "slash" && /\s/.test(query)) ||
      query.length > 48
    ) {
      closeMentionPicker();
      return;
    }
    const rect = ref.current!.getBoundingClientRect();
    const selection = window.getSelection();
    const caretRect =
      selection && selection.rangeCount > 0
        ? selection.getRangeAt(0).getBoundingClientRect()
        : null;
    openMentionPicker({
      kind,
      date,
      nodeId: node.id,
      start,
      query,
      left: caretRect && caretRect.left > 0 ? caretRect.left : rect.left,
      top: (caretRect && caretRect.bottom > 0 ? caretRect.bottom : rect.bottom) + 4,
    });
  };

  const onInput = (event: ReactFormEvent<HTMLDivElement>) => {
    const element = ref.current!;
    let segments = readSegments(element);
    shown.current = segments;
    const caret = getSelectionOffsets(element)?.start ?? 0;
    const grown = segmentsLength(segments) - segmentsLength(node.segments);
    const composing = (event.nativeEvent as InputEvent).isComposing;
    const first = segments[0];
    const before = { id: node.id, offset: Math.max(0, caret - grown) };
    const todoPrefix =
      !composing && node.todo === null && first?.kind === "text"
        ? TODO_PREFIX.exec(first.text)
        : null;
    if (todoPrefix) {
      const todo = /[xX]/.test(todoPrefix[0]) ? "done" : "todo";
      segments = deleteRange(segments, 0, todoPrefix[0].length);
      edit(
        (tree) => updateNode(tree, node.id, (current) => ({ ...current, segments, todo })),
        undefined,
        before,
      );
      requestFocus(date, node.id, Math.max(0, caret - todoPrefix[0].length));
      return;
    }
    const stylePrefix =
      !composing && node.style === "text" && first?.kind === "text"
        ? STYLE_PREFIXES.map((entry) => ({ entry, match: entry.pattern.exec(first.text) })).find(
            (candidate) => candidate.match !== null,
          )
        : undefined;
    if (stylePrefix?.match) {
      const style = stylePrefix.entry.style(stylePrefix.match);
      const length = stylePrefix.match[0].length;
      segments = deleteRange(segments, 0, length);
      edit(
        (tree) => updateNode(tree, node.id, (current) => ({ ...current, segments, style })),
        undefined,
        before,
      );
      requestFocus(date, node.id, Math.max(0, caret - length));
      return;
    }
    if (!composing && grown > 0) {
      segments = keepLinkEnd(segments, caret - grown, caret, endsLink(caret - grown));
    }
    if (!composing && pending.current && grown > 0) {
      segments = applyPending(segments, caret - grown, caret);
    }
    const shortcut = composing ? null : applyTypingShortcut(segments, caret);
    if (shortcut) {
      segments = shortcut.segments;
      edit(
        (tree) => updateNode(tree, node.id, (current) => ({ ...current, segments })),
        undefined,
        before,
      );
      requestFocus(date, node.id, shortcut.caret);
      return;
    }
    edit(
      (tree) => updateNode(tree, node.id, (current) => ({ ...current, segments })),
      `type:${node.id}`,
      before,
    );
    syncPicker(segments, caret);
  };

  const onCompositionEnd = () => {
    const started = compositionStart.current;
    compositionStart.current = null;
    if (started === null) return;
    const { offset: start, atLinkEnd } = started;
    const element = ref.current!;
    const caret = getSelectionOffsets(element)?.start ?? start;
    if (caret <= start) return;
    const typed = readSegments(element);
    const segments = applyPending(keepLinkEnd(typed, start, caret, atLinkEnd), start, caret);
    if (segmentsKey(segments) === segmentsKey(typed)) return;
    edit((tree) => updateNode(tree, node.id, (current) => ({ ...current, segments })), undefined, {
      id: node.id,
      offset: start,
    });
    requestFocus(date, node.id, caret);
  };

  const focusRow = (target: HTMLElement | undefined, place: (el: HTMLElement) => void) => {
    if (!target) return false;
    target.focus({ preventScroll: true });
    place(target);
    target.scrollIntoView({ block: "nearest" });
    return true;
  };

  const siblingRow = (delta: -1 | 1) => {
    const rows = view.rowTexts();
    const index = rows.indexOf(ref.current!);
    return index < 0 ? undefined : rows[index + delta];
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    const element = ref.current!;
    const mod = isMod(event);
    const picker = useMentionPickerStore.getState().picker;
    if (picker && picker.nodeId === node.id) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveMentionHighlight(event.key === "ArrowDown" ? 1 : -1, view.mentionCount());
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && view.mentionCount() > 0) {
        event.preventDefault();
        view.chooseMention();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentionPicker();
        return;
      }
    }

    if (/^(Arrow|Home|End|Page)/.test(event.key)) pending.current = null;

    const key = event.key.toLowerCase();
    if (mod && !event.altKey && !event.shiftKey && (key === "b" || key === "i" || key === "e")) {
      event.preventDefault();
      format(key === "b" ? "bold" : key === "i" ? "italic" : "code");
      return;
    }
    if (mod && event.shiftKey && !event.altKey && key === "x") {
      event.preventDefault();
      format("strike");
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && key === "k") {
      const range = selectedRange(element);
      if (!range) return;
      const existing = linkRangeAt(date, node.id, range.start);
      // With nothing selected outside a link, Mod+K stays the command palette.
      if (range.start === range.end && !existing) return;
      event.preventDefault();
      const target =
        range.start === range.end && existing
          ? existing
          : { ...range, href: existing && range.end <= existing.end ? existing.href : "" };
      view.editLink(target, target.href);
      return;
    }
    if (mod && event.altKey && /^Digit[0-3]$/.test(event.code)) {
      event.preventDefault();
      const level = Number(event.code.slice(5));
      setStyle(level === 0 ? "text" : (["h1", "h2", "h3"] as const)[level - 1]!);
      return;
    }
    if (mod && event.shiftKey && !event.altKey && event.code === "Digit7") {
      event.preventDefault();
      setStyle("ordered");
      return;
    }

    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      restore(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (!isMac && event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      restore("redo");
      return;
    }

    if (event.key === "Enter" && mod) {
      event.preventDefault();
      edit((tree) =>
        updateNode(tree, node.id, (current) => ({ ...current, todo: cycleTodo(current.todo) })),
      );
      return;
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      const { start, end } = offsets();
      const segments = insertSegments(deleteRange(node.segments, start, end), start, [
        { kind: "text", text: "\n" },
      ]);
      edit((tree) => updateNode(tree, node.id, (current) => ({ ...current, segments })));
      requestFocus(date, node.id, start + 1);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      closeMentionPicker();
      const { start, end } = offsets();
      const segments = deleteRange(node.segments, start, end);
      const empty = segmentsLength(segments) === 0;
      if (empty && node.todo !== null && node.children.length === 0) {
        edit((tree) =>
          updateNode(tree, node.id, (current) => ({ ...current, todo: null, segments })),
        );
        return;
      }
      if (empty && node.style !== "text" && node.children.length === 0) {
        edit((tree) =>
          updateNode(tree, node.id, (current) => ({ ...current, style: "text", segments })),
        );
        return;
      }
      if (empty && node.children.length === 0) {
        let handled = false;
        edit((tree) => {
          const location = locate(tree, node.id);
          if (
            location &&
            location.parentId !== null &&
            location.index === location.siblings.length - 1
          ) {
            handled = true;
            return outdentNode(tree, node.id);
          }
          return null;
        });
        if (handled) {
          requestFocus(date, node.id, 0);
          return;
        }
      }
      if (start === 0 && !empty) {
        const fresh = makeNode({
          todo: node.todo === null ? null : "todo",
          style: node.style === "ordered" ? "ordered" : "text",
        });
        edit((tree) => {
          const location = locate(tree, node.id);
          return location ? insertNodes(tree, location.parentId, location.index, [fresh]) : null;
        });
        requestFocus(date, node.id, 0);
        return;
      }
      const [left, right] = splitSegments(segments, start);
      const fresh = makeNode({
        segments: right,
        todo: node.todo === null ? null : "todo",
        style: node.style === "ordered" || node.style === "quote" ? node.style : "text",
      });
      const asChild = node.children.length > 0 && !node.collapsed;
      edit((tree) => {
        const updated = updateNode(tree, node.id, (current) => ({ ...current, segments: left }));
        return asChild
          ? insertNodes(updated, node.id, 0, [fresh])
          : insertAfter(updated, node.id, fresh);
      });
      requestFocus(date, fresh.id, 0);
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      const caret = offsets().start;
      edit((tree) => (event.shiftKey ? outdentNode(tree, node.id) : indentNode(tree, node.id)));
      requestFocus(date, node.id, caret);
      return;
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && mod && event.shiftKey) {
      event.preventDefault();
      const caret = offsets().start;
      edit((tree) => moveAmongSiblings(tree, node.id, event.key === "ArrowUp" ? -1 : 1));
      requestFocus(date, node.id, caret);
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && mod && !event.altKey) {
      event.preventDefault();
      editDay(date, (tree) => setCollapsed(tree, node.id, event.key === "ArrowUp"));
      return;
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !mod) {
      const edge = caretLineEdge(element);
      const up = event.key === "ArrowUp";
      if (event.shiftKey) {
        const { start, end } = offsets();
        const atEdge = up
          ? edge.first && start === 0
          : edge.last && end === segmentsLength(node.segments);
        if (atEdge) {
          event.preventDefault();
          setBlockSelection({ date, anchorId: node.id, headId: node.id });
          view.focusSelectionHost();
        }
        return;
      }
      if (up ? edge.first : edge.last) {
        if (
          focusRow(siblingRow(up ? -1 : 1), (target) =>
            placeCaretAtX(target, edge.x, up ? "bottom" : "top"),
          )
        ) {
          event.preventDefault();
        }
      }
      return;
    }

    if (event.key === "ArrowLeft" && !event.shiftKey && !mod && !event.altKey) {
      const { start, end } = offsets();
      if (start === 0 && end === 0) {
        if (focusRow(siblingRow(-1), (target) => setCaret(target, readSegmentsLength(target)))) {
          event.preventDefault();
        }
      }
      return;
    }
    if (event.key === "ArrowRight" && !event.shiftKey && !mod && !event.altKey) {
      const { start, end } = offsets();
      const length = segmentsLength(node.segments);
      if (start === length && end === length) {
        if (focusRow(siblingRow(1), (target) => setCaret(target, 0))) event.preventDefault();
      }
      return;
    }

    if (event.key === "Backspace" && !mod && !event.altKey) {
      const { start, end } = offsets();
      if (start !== 0 || end !== 0) return;
      event.preventDefault();
      if (node.style !== "text") {
        edit((tree) => updateNode(tree, node.id, (current) => ({ ...current, style: "text" })));
        return;
      }
      let focusTarget: { id: string; offset: number } | null = null;
      edit((tree) => {
        const previous = previousVisible(tree, node.id);
        if (!previous) {
          if (node.todo !== null) {
            return updateNode(tree, node.id, (current) => ({ ...current, todo: null }));
          }
          return null;
        }
        focusTarget = { id: previous.id, offset: segmentsLength(previous.segments) };
        return mergeInto(tree, previous.id, node.id);
      });
      const target = focusTarget as { id: string; offset: number } | null;
      if (target) requestFocus(date, target.id, target.offset);
      return;
    }

    if (event.key === "Delete" && !mod && !event.altKey) {
      const { start, end } = offsets();
      const length = segmentsLength(node.segments);
      if (start !== length || end !== length) return;
      event.preventDefault();
      edit((tree) => {
        const next = nextVisible(tree, node.id);
        return next ? mergeInto(tree, node.id, next.id) : null;
      });
      requestFocus(date, node.id, length);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setBlockSelection({ date, anchorId: node.id, headId: node.id });
      view.focusSelectionHost();
      return;
    }

    if (mod && event.key.toLowerCase() === "a" && !event.shiftKey) {
      const { start, end } = offsets();
      const length = segmentsLength(node.segments);
      if (length === 0 || (start === 0 && end === length)) {
        event.preventDefault();
        setBlockSelection({ date, anchorId: node.id, headId: node.id });
        view.focusSelectionHost();
      }
    }
  };

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const { start, end } = offsets();
    const base = deleteRange(node.segments, start, end);
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (!normalized.includes("\n")) {
      const inserted = parseInlineSegments(normalized);
      edit((tree) =>
        updateNode(tree, node.id, (current) => ({
          ...current,
          segments: insertSegments(base, start, inserted),
        })),
      );
      requestFocus(date, node.id, start + segmentsLength(inserted));
      return;
    }
    const pasted = parseNote(normalized);
    if (pasted.length === 0) return;
    const last = pasted.at(-1)!;
    const replaceCurrent =
      segmentsLength(base) === 0 && node.children.length === 0 && node.todo === null;
    edit((tree) => {
      const location = locate(tree, node.id);
      if (!location) return null;
      if (replaceCurrent) {
        return insertNodes(removeNode(tree, node.id), location.parentId, location.index, pasted);
      }
      const updated = updateNode(tree, node.id, (current) => ({ ...current, segments: base }));
      return insertNodes(updated, location.parentId, location.index + 1, pasted);
    });
    requestFocus(date, last.id, "end");
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>("[data-href]");
    if (link && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      openNoteLink(link.dataset.href ?? "");
      return;
    }
    const mention = (event.target as HTMLElement).closest<HTMLElement>("[data-mention]");
    if (!mention) return;
    event.preventDefault();
    view.openThread(mention.dataset.environmentId ?? "", mention.dataset.threadId ?? "");
  };

  return (
    <div
      ref={ref}
      data-note-text=""
      data-date={date}
      data-node-id={node.id}
      role="textbox"
      aria-multiline="true"
      aria-label={gt("Note")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={props.placeholder ?? undefined}
      className={cn(
        "min-w-0 flex-1 cursor-text break-words whitespace-pre-wrap outline-none",
        props.density === "compact" ? "py-px" : "py-0.5",
        LINE_LOOK[props.density][node.style].text,
        node.style === "quote" && "border-l-2 border-border pl-2.5 text-muted-foreground",
        node.todo === "done" && "text-muted-foreground line-through decoration-muted-foreground/60",
        props.placeholder &&
          "empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)] [&:has(>br:only-child)]:before:text-muted-foreground/60 [&:has(>br:only-child)]:before:content-[attr(data-placeholder)]",
      )}
      onInput={onInput}
      onCompositionStart={() => {
        const offset = getSelectionOffsets(ref.current!)?.start;
        compositionStart.current =
          offset === undefined ? null : { offset, atLinkEnd: endsLink(offset) };
      }}
      onCompositionEnd={onCompositionEnd}
      onPointerDown={() => {
        pending.current = null;
      }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={onClick}
      onFocus={() => {
        setEditingDate(date);
        if (useDailyNotesStore.getState().selection) setBlockSelection(null);
      }}
      onBlur={() => {
        setEditingDate(null);
        pending.current = null;
        const picker = useMentionPickerStore.getState().picker;
        if (picker?.nodeId === node.id) setTimeout(closeMentionPickerIfBlurred, 150);
      }}
    />
  );
}

function closeMentionPickerIfBlurred() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.dataset.noteText === undefined)
    closeMentionPicker();
}

function readSegmentsLength(element: HTMLElement) {
  return segmentsLength(readSegments(element));
}

const NoteText = memo(NoteTextImpl);

export const NoteRow = memo(function NoteRow(props: {
  readonly date: string;
  readonly node: NoteNode;
  readonly depth: number;
  readonly selected: boolean;
  readonly placeholder: string | null;
  readonly density: NoteDensity;
  /** The number of a numbered line. */
  readonly ordinal: number | null;
}) {
  const { date, node, depth } = props;
  const gt = useGT();
  const compact = props.density === "compact";
  const isDocument = props.density === "document";
  const rowHeight = LINE_LOOK[props.density][node.style].height;
  const quietBullet =
    (node.segments.length === 0 && node.children.length === 0 && node.todo === null) ||
    (isDocument && node.todo !== null) ||
    node.style === "h1" ||
    node.style === "h2" ||
    node.style === "h3" ||
    node.style === "quote";
  const view = useNotesView();
  const hasChildren = node.children.length > 0;
  return (
    <div
      data-note-row=""
      data-node-id={node.id}
      data-depth={depth}
      className={cn(
        "group/row relative flex items-start rounded-sm pr-1",
        props.selected && "bg-primary/10",
      )}
      style={{ paddingLeft: depth * indentFor(props.density) }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={node.collapsed ? gt("Expand") : gt("Collapse")}
        className={cn(
          "-ml-4 flex w-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground opacity-0 outline-none hover:text-foreground",
          rowHeight,
          hasChildren && "group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          !hasChildren && "pointer-events-none",
        )}
        onClick={() => editDay(date, (tree) => setCollapsed(tree, node.id, !node.collapsed))}
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", !node.collapsed && "rotate-90")}
        />
      </button>
      <span
        role="button"
        tabIndex={-1}
        aria-label={gt("Drag to move, click to select")}
        data-note-bullet=""
        className={cn(
          "group/bullet flex shrink-0 cursor-grab touch-none items-center justify-center",
          rowHeight,
          compact ? "w-4" : isDocument ? "w-6" : "w-5",
        )}
        onPointerDown={(event) => view.startBulletDrag(event, date, node.id)}
      >
        <span
          className={cn(
            "flex min-w-4 items-center justify-center rounded-full group-hover/bullet:bg-accent",
            props.ordinal === null && "size-4",
            node.collapsed && hasChildren && "bg-muted-foreground/20",
          )}
        >
          {props.ordinal !== null ? (
            <span
              className={cn(
                "px-0.5 text-muted-foreground tabular-nums",
                compact ? "text-xs" : isDocument ? "text-base" : "text-sm",
              )}
            >
              {props.ordinal}.
            </span>
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full bg-foreground/55",
                // A document marks levels the way word processors do: dot, ring, square.
                isDocument && depth % 3 === 1 && "border border-foreground/60 bg-transparent",
                isDocument && depth % 3 === 2 && "rounded-xs",
                quietBullet &&
                  "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
              )}
            />
          )}
        </span>
      </span>
      {node.todo !== null ? (
        <span
          className={cn(
            "flex shrink-0 items-center",
            rowHeight,
            compact ? "pr-1" : isDocument ? "pr-2" : "pr-1.5",
          )}
        >
          <input
            type="checkbox"
            tabIndex={-1}
            aria-label={node.todo === "done" ? gt("Mark as not done") : gt("Mark as done")}
            checked={node.todo === "done"}
            className={cn(
              "cursor-pointer accent-primary",
              compact ? "size-3" : isDocument ? "size-4" : "size-3.5",
            )}
            onChange={() =>
              editDay(date, (tree) =>
                updateNode(tree, node.id, (current) => ({
                  ...current,
                  todo: current.todo === "done" ? "todo" : "done",
                })),
              )
            }
          />
        </span>
      ) : null}
      <NoteText date={date} node={node} placeholder={props.placeholder} density={props.density} />
    </div>
  );
});
