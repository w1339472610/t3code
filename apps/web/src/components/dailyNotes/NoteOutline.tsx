import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
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
import { paintMention, resolveMention, useNoteThreadIndex } from "./noteThreads";

export const INDENT_PX = 22;

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
    setCaret(
      element,
      focus.offset === "end"
        ? length
        : focus.offset === "start"
          ? 0
          : Math.min(focus.offset, length),
    );
    element.scrollIntoView({ block: "nearest" });
    clearFocusRequest(focus.nonce);
  }, [focus, node.segments]);

  const edit = (update: (tree: NoteTree) => NoteTree | null, coalesceKey?: string) =>
    editDay(date, update, { focusId: node.id, ...(coalesceKey ? { coalesceKey } : {}) });

  const offsets = () => {
    const element = ref.current!;
    return (
      getSelectionOffsets(element) ?? {
        start: segmentsLength(node.segments),
        end: segmentsLength(node.segments),
      }
    );
  };

  const syncPicker = (segments: ReadonlyArray<NoteSegment>, caret: number) => {
    const text = segments.map((s) => (s.kind === "text" ? s.text : "￼")).join("");
    const picker = useMentionPickerStore.getState().picker;
    const start =
      picker && picker.nodeId === node.id
        ? picker.start
        : (() => {
            const before = text[caret - 1];
            const prior = text[caret - 2];
            return (before === "@" || before === "＠") &&
              (prior === undefined || /[\s￼([（]/.test(prior))
              ? caret - 1
              : null;
          })();
    if (start === null) return;
    const query = text.slice(start + 1, caret);
    if (
      caret <= start ||
      (text[start] !== "@" && text[start] !== "＠") ||
      /[\n￼]/.test(query) ||
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
      date,
      nodeId: node.id,
      start,
      query,
      left: caretRect && caretRect.left > 0 ? caretRect.left : rect.left,
      top: (caretRect && caretRect.bottom > 0 ? caretRect.bottom : rect.bottom) + 4,
    });
  };

  const onInput = () => {
    const element = ref.current!;
    const segments = readSegments(element);
    shown.current = segments;
    edit(
      (tree) => updateNode(tree, node.id, (current) => ({ ...current, segments })),
      `type:${node.id}`,
    );
    syncPicker(segments, getSelectionOffsets(element)?.start ?? 0);
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

    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      const focusId = undoDay(date, event.shiftKey ? "redo" : "undo");
      if (focusId) requestFocus(date, focusId, "end");
      return;
    }
    if (!isMac && event.ctrlKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      const focusId = undoDay(date, "redo");
      if (focusId) requestFocus(date, focusId, "end");
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
        const fresh = makeNode({ todo: node.todo === null ? null : "todo" });
        edit((tree) => {
          const location = locate(tree, node.id);
          return location ? insertNodes(tree, location.parentId, location.index, [fresh]) : null;
        });
        requestFocus(date, node.id, 0);
        return;
      }
      const [left, right] = splitSegments(segments, start);
      const fresh = makeNode({ segments: right, todo: node.todo === null ? null : "todo" });
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
        "min-h-6 min-w-0 flex-1 cursor-text py-0.5 text-sm/5 break-words whitespace-pre-wrap outline-none",
        node.todo === "done" && "text-muted-foreground line-through decoration-muted-foreground/60",
        props.placeholder &&
          "empty:before:pointer-events-none empty:before:text-muted-foreground/60 empty:before:content-[attr(data-placeholder)] [&:has(>br:only-child)]:before:text-muted-foreground/60 [&:has(>br:only-child)]:before:content-[attr(data-placeholder)]",
      )}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={onClick}
      onFocus={() => {
        setEditingDate(date);
        if (useDailyNotesStore.getState().selection) setBlockSelection(null);
      }}
      onBlur={() => {
        setEditingDate(null);
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
}) {
  const { date, node, depth } = props;
  const gt = useGT();
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
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={node.collapsed ? gt("Expand") : gt("Collapse")}
        className={cn(
          "-ml-4 flex h-6 w-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground opacity-0 outline-none hover:text-foreground",
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
        className="group/bullet flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center"
        onPointerDown={(event) => view.startBulletDrag(event, date, node.id)}
      >
        <span
          className={cn(
            "flex size-4 items-center justify-center rounded-full group-hover/bullet:bg-accent",
            node.collapsed && hasChildren && "bg-muted-foreground/20",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full bg-foreground/55",
              node.segments.length === 0 &&
                !hasChildren &&
                node.todo === null &&
                "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
            )}
          />
        </span>
      </span>
      {node.todo !== null ? (
        <span className="flex h-6 shrink-0 items-center pr-1.5">
          <input
            type="checkbox"
            tabIndex={-1}
            aria-label={node.todo === "done" ? gt("Mark as not done") : gt("Mark as done")}
            checked={node.todo === "done"}
            className="size-3.5 cursor-pointer accent-primary"
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
      <NoteText date={date} node={node} placeholder={props.placeholder} />
    </div>
  );
});
