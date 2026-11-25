import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import * as Schema from "effect/Schema";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  NotebookPenIcon,
} from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { observeResize } from "~/lib/observeResize";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  THREAD_CONTEXT_DROP_EVENT,
  THREAD_CONTEXT_HOVER_EVENT,
  THREAD_CONTEXT_LEAVE_EVENT,
  threadContextDropTargetProps,
} from "../chat/threadContextDrag";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { addPendingConversion } from "./DailyNotesBackground";
import {
  editDay,
  readDayTree,
  requestFocus,
  setBlockSelection,
  undoDay,
  useDailyNotesStore,
} from "./dailyNotesStore";
import { closeMentionPicker, useMentionPickerStore } from "./mentionPickerStore";
import {
  dateFromKey,
  inView,
  localDateKey,
  monthGrid,
  type NotesViewMode,
  sameMonth,
  startOfWeek,
  stepAnchor,
  weekDays,
} from "./noteDates";
import {
  cycleSelectionTodo,
  type DayLayout,
  DaySection,
  dayLabels,
  type DropLine,
  OutsideMonthCell,
  selectedNodes,
  subtreeIds,
} from "./NoteDay";
import { getSelectionOffsets } from "./noteDom";
import { NotesViewContext, type NotesViewApi } from "./NoteOutline";
import {
  type DropTarget,
  indentNode,
  insertAtTarget,
  insertNodes,
  insertSegments,
  locate,
  makeNode,
  moveAmongSiblings,
  moveNodesTo,
  type NoteNode,
  type NoteTree,
  nodePromptText,
  nodesToMarkdown,
  outdentNode,
  parseNote,
  removeNodes,
  segmentsKey,
  updateNode,
  visibleRows,
  type VisibleRow,
} from "./noteModel";
import {
  buildNoteThreadIndex,
  NoteThreadIndexContext,
  type NoteThreadInfo,
  noteThreadStatusMessage,
  resolveMention,
} from "./noteThreads";

/** doc: every day with notes as one continuous document, newest first. */
type NotesView = "doc" | NotesViewMode;
const ViewModeSchema = Schema.Literals(["doc", "day", "week", "month"]);
const DOC_PAGE_SIZE = 12;
/** The date index beside the document needs this much width. */
const DATE_INDEX_MIN_WIDTH = 900;
/** Narrower than these, week and month stack their days instead of laying out a grid. */
const WEEK_GRID_MIN_WIDTH = 560;
const MONTH_GRID_MIN_WIDTH = 860;

/** Where a drop at (x, y) lands among a day's rows: between two rows, at the depth x points to. */
function computeDrop(
  dayElement: HTMLElement,
  date: string,
  tree: NoteTree,
  point: { x: number; y: number },
  exclude: ReadonlySet<string>,
): DropLine {
  const indent = Number(dayElement.dataset.indent) || 22;
  const bullet = Number(dayElement.dataset.bullet) || 20;
  const rowsById = new Map(visibleRows(tree).map((row) => [row.node.id, row]));
  const elements = [...dayElement.querySelectorAll<HTMLElement>("[data-note-row]")].filter(
    (element) => !exclude.has(element.dataset.nodeId ?? ""),
  );
  const list = elements.flatMap((element) => {
    const row = rowsById.get(element.dataset.nodeId ?? "");
    return row ? [{ element, row }] : [];
  });
  const outline = dayElement.querySelector<HTMLElement>("[data-note-outline]") ?? dayElement;
  const outlineBox = outline.getBoundingClientRect();
  let insertAt = list.length;
  for (let index = 0; index < list.length; index++) {
    const box = list[index]!.element.getBoundingClientRect();
    if (point.y < box.top + box.height / 2) {
      insertAt = index;
      break;
    }
  }
  const above = list[insertAt - 1]?.row ?? null;
  const below = list[insertAt]?.row ?? null;
  const minDepth = below && above ? Math.min(below.depth, above.depth + 1) : 0;
  const maxDepth = above ? above.depth + 1 : 0;
  const wanted = Math.round((point.x - outlineBox.left - bullet) / indent);
  const depth = Math.max(minDepth, Math.min(maxDepth, wanted));
  const top = above
    ? list[insertAt - 1]!.element.getBoundingClientRect().bottom - outlineBox.top
    : below
      ? list[insertAt]!.element.getBoundingClientRect().top - outlineBox.top
      : 0;
  let target: DropTarget = { parentId: null, afterId: null };
  if (above) {
    if (depth === above.depth + 1) {
      target = { parentId: above.node.id, afterId: null };
    } else {
      let anchor: VisibleRow = above;
      while (anchor.depth > depth && anchor.parentId !== null) {
        anchor = rowsById.get(anchor.parentId) ?? anchor;
        if (anchor.parentId === null && anchor.depth > depth) break;
      }
      target = { parentId: anchor.parentId, afterId: anchor.node.id };
    }
  }
  return { date, target, top, left: depth * indent + bullet };
}

function dropAt(point: { x: number; y: number }, exclude: ReadonlySet<string>): DropLine | null {
  const dayElement = document
    .elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>("[data-note-day]");
  const date = dayElement?.dataset.noteDay;
  const tree = date ? readDayTree(date) : null;
  return dayElement && date && tree ? computeDrop(dayElement, date, tree, point, exclude) : null;
}

/** The node every selected node sits under, or null when that is the day itself. */
function commonParent(tree: NoteTree, nodes: ReadonlyArray<NoteNode>): string | null {
  const chains = nodes.map((node) => {
    const chain: string[] = [];
    let parent = locate(tree, node.id)?.parentId ?? null;
    while (parent !== null) {
      chain.unshift(parent);
      parent = locate(tree, parent)?.parentId ?? null;
    }
    return chain;
  });
  const [first = [], ...rest] = chains;
  let shared: string | null = null;
  for (let index = 0; index < first.length; index++) {
    if (rest.some((chain) => chain[index] !== first[index])) break;
    shared = first[index]!;
  }
  return shared;
}

interface BulletDrag {
  readonly date: string;
  readonly nodes: ReadonlyArray<NoteNode>;
  readonly extend: boolean;
  readonly startX: number;
  readonly startY: number;
  readonly active: boolean;
  readonly x: number;
  readonly y: number;
  readonly line: DropLine | null;
}

function rangeTitle(mode: NotesView, anchor: string, today: string): string {
  const thisYear = anchor.slice(0, 4) === today.slice(0, 4);
  if (mode === "day" || mode === "doc") return "";
  if (mode === "month") {
    return dateFromKey(anchor).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  }
  const days = weekDays(anchor);
  const format = (key: string) =>
    dateFromKey(key).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(thisYear ? {} : { year: "numeric" }),
    });
  return `${format(days[0]!)} – ${format(days[6]!)}`;
}

export function DailyNotesView(props: { readonly variant: "page" | "panel" }) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const today = localDateKey(new Date(`${nowMinute}:00.000Z`));
  const [mode, setMode] = useLocalStorage<NotesView, NotesView>(
    `t3code:daily-notes:view:${props.variant}`,
    "doc",
    ViewModeSchema,
  );
  const [dateIndexOpen, setDateIndexOpen] = useLocalStorage(
    "t3code:daily-notes:date-index",
    true,
    Schema.Boolean,
  );
  const [docLimit, setDocLimit] = useState(DOC_PAGE_SIZE);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [jumpNonce, setJumpNonce] = useState(0);
  const pendingJump = useRef<string | null>(null);
  /** A day jumped to stays marked until the user scrolls, even when it cannot reach the top. */
  const jumpedDate = useRef<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [anchorState, setAnchorState] = useState<string | null>(null);
  const anchor = anchorState ?? today;
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [convert, setConvert] = useState<{ date: string; nodeId: string } | null>(null);
  const [drag, setDrag] = useState<BulletDrag | null>(null);
  const [threadDrop, setThreadDrop] = useState<DropLine | null>(null);
  const [rangeSelecting, setRangeSelecting] = useState(false);
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionHostRef = useRef<HTMLDivElement>(null);
  const threadDropRef = useRef<DropLine | null>(null);
  const dragRef = useRef<BulletDrag | null>(null);
  const updateDrag = (next: BulletDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  const setAnchor = (date: string) => setAnchorState(date === today ? null : date);

  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.dailyNotesLive({ environmentId, input: {} }),
  ).data;
  const threadShells = useQuietThreadShells();
  const threadIndex = buildNoteThreadIndex(
    threadShells,
    Date.parse(`${nowMinute}:00.000Z`),
    gt("Untitled thread"),
  );
  const noteDates = new Set(snapshot?.days.map((day) => day.date) ?? []);
  const knownEmpty = (date: string) => snapshot !== undefined && !noteDates.has(date);

  const grid = width >= (mode === "month" ? MONTH_GRID_MIN_WIDTH : WEEK_GRID_MIN_WIDTH);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- week and month pick a grid or a stacked list from the measured width of the notes area
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    setWidth(element.clientWidth);
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);

  const picker = useMentionPickerStore((state) => state.picker);
  const mentionCandidates = picker ? filterMentionCandidates(threadIndex, picker.query) : [];

  const insertMention = (thread: NoteThreadInfo) => {
    const current = useMentionPickerStore.getState().picker;
    if (!current) return;
    closeMentionPicker();
    const element = rootRef.current?.querySelector<HTMLElement>(
      `[data-note-text][data-node-id="${current.nodeId}"]`,
    );
    const end =
      (element ? getSelectionOffsets(element)?.start : undefined) ??
      current.start + 1 + current.query.length;
    editDay(current.date, (tree) =>
      updateNode(tree, current.nodeId, (node) => {
        const [before] = splitAt(node, current.start);
        const after = splitAt(node, end)[1];
        return {
          ...node,
          segments: insertSegments([...before, ...after], current.start, [
            {
              kind: "thread",
              environmentId: thread.environmentId,
              threadId: thread.threadId,
              title: thread.title,
            },
            { kind: "text", text: " " },
          ]),
        };
      }),
    );
    requestFocus(current.date, current.nodeId, current.start + 2);
  };

  const openThread = (environment: string, threadId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: environment as EnvironmentId, threadId: threadId as ThreadId },
    });
  };

  const openDay = (date: string) => {
    setAnchor(date);
    setMode("day");
    rootRef.current?.scrollTo({ top: 0 });
  };

  const focusSelectionHost = () => selectionHostRef.current?.focus({ preventScroll: true });

  const api: NotesViewApi = {
    rowTexts: () => [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-note-text]") ?? [])],
    openThread,
    startBulletDrag: (event, date, nodeId) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const tree = readDayTree(date);
      if (!tree) return;
      const selection = useDailyNotesStore.getState().selection;
      const selected =
        selection && selection.date === date
          ? selectedNodes(tree, selection.anchorId, selection.headId)
          : [];
      const node = locate(tree, nodeId)?.node;
      if (!node) return;
      const nodes = selected.some((entry) => subtreeIds([entry]).has(nodeId)) ? selected : [node];
      updateDrag({
        date,
        nodes,
        extend: event.shiftKey,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        line: null,
      });
    },
    chooseMention: () => {
      const choice = mentionCandidates[useMentionPickerStore.getState().picker?.highlighted ?? 0];
      if (!choice) return false;
      insertMention(choice);
      return true;
    },
    mentionCount: () => mentionCandidates.length,
    focusSelectionHost,
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the pointer outside React while a bullet is dragged
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const active =
        current.active ||
        Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
      if (!active) return;
      updateDrag({
        ...current,
        active,
        x: event.clientX,
        y: event.clientY,
        line: dropAt({ x: event.clientX, y: event.clientY }, subtreeIds(current.nodes)),
      });
    };
    const up = () => {
      const current = dragRef.current;
      updateDrag(null);
      if (!current) return;
      if (!current.active) {
        const node = current.nodes[0];
        if (!node) return;
        const selection = useDailyNotesStore.getState().selection;
        setBlockSelection(
          current.extend && selection?.date === current.date
            ? { ...selection, headId: node.id }
            : { date: current.date, anchorId: node.id, headId: node.id },
        );
        focusSelectionHost();
        return;
      }
      const line = current.line;
      if (!line) return;
      if (line.date === current.date) {
        editDay(current.date, (tree) => moveNodesTo(tree, current.nodes, line.target));
        return;
      }
      // Another day: add there first so a refused drop never loses the notes.
      if (editDay(line.date, (tree) => insertAtTarget(tree, current.nodes, line.target))) {
        editDay(current.date, (tree) =>
          removeNodes(
            tree,
            current.nodes.map((node) => node.id),
          ),
        );
        setBlockSelection(null);
      }
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") updateDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", cancel);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- listeners read the latest drag from dragRef; only starting or ending a drag resubscribes
  }, [drag !== null]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for threads dragged out of the sidebar, which arrive as DOM events
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const hover = (event: Event) => {
      const point = (event as CustomEvent<{ x: number; y: number }>).detail;
      threadDropRef.current = dropAt(point, new Set());
      setThreadDrop(threadDropRef.current);
    };
    const leave = () => {
      threadDropRef.current = null;
      setThreadDrop(null);
    };
    const drop = (event: Event) => {
      const refs = (event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail;
      const line = threadDropRef.current;
      leave();
      if (!line || refs.length === 0) return;
      const nodes = refs.map((ref) =>
        makeNode({
          segments: [
            {
              kind: "thread",
              environmentId: ref.environmentId,
              threadId: ref.threadId,
              title: resolveMention(threadIndex, {
                kind: "thread",
                environmentId: ref.environmentId,
                threadId: ref.threadId,
                title: "",
              }).title,
            },
          ],
        }),
      );
      editDay(line.date, (tree) => insertAtTarget(tree, nodes, line.target));
    };
    root.addEventListener(THREAD_CONTEXT_HOVER_EVENT, hover);
    root.addEventListener(THREAD_CONTEXT_LEAVE_EVENT, leave);
    root.addEventListener(THREAD_CONTEXT_DROP_EVENT, drop);
    return () => {
      root.removeEventListener(THREAD_CONTEXT_HOVER_EVENT, hover);
      root.removeEventListener(THREAD_CONTEXT_LEAVE_EVENT, leave);
      root.removeEventListener(THREAD_CONTEXT_DROP_EVENT, drop);
    };
  });

  /** Dragging out of one line into others selects whole lines; Shift-click extends to a line. */
  const onRootPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const target = event.target as HTMLElement;
    const text = target.closest<HTMLElement>("[data-note-text]");
    if (!text) return;
    const date = text.dataset.date ?? "";
    const nodeId = text.dataset.nodeId ?? "";
    if (event.shiftKey) {
      const selection = useDailyNotesStore.getState().selection;
      const active = document.activeElement as HTMLElement | null;
      const anchorId =
        selection?.date === date
          ? selection.anchorId
          : active?.dataset.noteText !== undefined && active.dataset.date === date
            ? (active.dataset.nodeId ?? null)
            : null;
      if (anchorId !== null && anchorId !== nodeId) {
        event.preventDefault();
        setBlockSelection({ date, anchorId, headId: nodeId });
        focusSelectionHost();
      }
      return;
    }
    let selecting = false;
    const move = (moveEvent: PointerEvent) => {
      const row = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>("[data-note-row]");
      const rowDate = row?.closest<HTMLElement>("[data-note-day]")?.dataset.noteDay;
      const headId = row?.dataset.nodeId;
      if (!selecting && (headId === undefined || headId === nodeId || rowDate !== date)) return;
      if (!selecting) {
        selecting = true;
        setRangeSelecting(true);
        focusSelectionHost();
      }
      window.getSelection()?.removeAllRanges();
      if (headId !== undefined && rowDate === date) {
        setBlockSelection({ date, anchorId: nodeId, headId });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (selecting) {
        window.getSelection()?.removeAllRanges();
        setRangeSelecting(false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selection = useDailyNotesStore((state) => state.selection);

  const onSelectionPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const current = useDailyNotesStore.getState().selection;
    const tree = current ? readDayTree(current.date) : null;
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!current || !tree || text.trim() === "") return;
    event.preventDefault();
    const nodes = selectedNodes(tree, current.anchorId, current.headId);
    const first = nodes[0] ? locate(tree, nodes[0].id) : null;
    const pasted = parseNote(text);
    const last = pasted.at(-1);
    if (!first || !last) return;
    editDay(current.date, (value) =>
      insertNodes(
        removeNodes(
          value,
          nodes.map((node) => node.id),
        ),
        first.parentId,
        first.index,
        pasted,
      ),
    );
    requestFocus(current.date, last.id, "end");
  };

  const onSelectionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys typed in a row's editor bubble up here; only the focused host handles block keys.
    if (event.target !== event.currentTarget) return;
    const current = useDailyNotesStore.getState().selection;
    if (!current) return;
    const tree = readDayTree(current.date);
    if (!tree) return;
    const mod = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
    const rows = visibleRows(tree);
    const headIndex = rows.findIndex((row) => row.node.id === current.headId);
    const nodes = selectedNodes(tree, current.anchorId, current.headId);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      handled();
      setBlockSelection(null);
      return;
    }
    if (event.key === "Enter" && !mod) {
      handled();
      requestFocus(current.date, current.headId, "end");
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && mod && event.shiftKey) {
      handled();
      if (nodes.length === 1) {
        editDay(current.date, (value) =>
          moveAmongSiblings(value, nodes[0]!.id, event.key === "ArrowUp" ? -1 : 1),
        );
      }
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      handled();
      const next = rows[headIndex + (event.key === "ArrowUp" ? -1 : 1)];
      if (!next) return;
      setBlockSelection(
        event.shiftKey
          ? { ...current, headId: next.node.id }
          : { date: current.date, anchorId: next.node.id, headId: next.node.id },
      );
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      handled();
      const previous = rows[rows.findIndex((row) => row.node.id === nodes[0]?.id) - 1];
      editDay(current.date, (value) =>
        removeNodes(
          value,
          nodes.map((node) => node.id),
        ),
      );
      setBlockSelection(null);
      if (previous) requestFocus(current.date, previous.node.id, "end");
      return;
    }
    if (mod && (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "x")) {
      handled();
      void navigator.clipboard.writeText(nodesToMarkdown(nodes));
      if (event.key.toLowerCase() === "x") {
        editDay(current.date, (value) =>
          removeNodes(
            value,
            nodes.map((node) => node.id),
          ),
        );
        setBlockSelection(null);
      }
      return;
    }
    if (mod && event.key === "Enter") {
      handled();
      cycleSelectionTodo(current.date, nodes);
      return;
    }
    if (event.key === "Tab") {
      handled();
      const ordered = event.shiftKey ? [...nodes].toReversed() : nodes;
      editDay(current.date, (value) => {
        let next: NoteTree = value;
        for (const node of ordered)
          next = (event.shiftKey ? outdentNode(next, node.id) : indentNode(next, node.id)) ?? next;
        return next;
      });
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      handled();
      undoDay(current.date, event.shiftKey ? "redo" : "undo");
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      handled();
      // Each press widens to the enclosing node, then to the whole day.
      const parent = commonParent(tree, nodes);
      if (parent !== null) {
        setBlockSelection({ date: current.date, anchorId: parent, headId: parent });
        return;
      }
      const first = rows[0];
      const last = rows.at(-1);
      if (first && last)
        setBlockSelection({ date: current.date, anchorId: first.node.id, headId: last.node.id });
    }
  };

  const docDays = [
    ...new Set([
      today,
      ...(anchorState === null ? [] : [anchorState]),
      ...[...noteDates].filter((date) => date <= today),
    ]),
  ].toSorted((a, b) => b.localeCompare(a));
  const shownActiveDate =
    activeDate !== null && docDays.includes(activeDate) ? activeDate : (docDays[0] ?? today);
  const showDateIndex =
    mode === "doc" && props.variant === "page" && dateIndexOpen && width >= DATE_INDEX_MIN_WIDTH;

  const jumpTo = (date: string) => {
    const list = docDays.includes(date)
      ? docDays
      : [...docDays, date].toSorted((a, b) => b.localeCompare(a));
    if (!docDays.includes(date)) setAnchorState(date === today ? null : date);
    setDocLimit((limit) => Math.max(limit, list.indexOf(date) + 3));
    pendingJump.current = date;
    setJumpNonce((nonce) => nonce + 1);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the document to a date once its section has rendered
  useLayoutEffect(() => {
    const date = pendingJump.current;
    if (date === null) return;
    const section = rootRef.current?.querySelector<HTMLElement>(`[data-note-day="${date}"]`);
    if (!section) return;
    pendingJump.current = null;
    jumpedDate.current = date;
    section.scrollIntoView({ block: "start" });
    setActiveDate(date);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a jump waits for its nonce, for more days to render, or for the document view to mount
  }, [jumpNonce, docLimit, mode]);

  const onRootScroll = () => {
    const element = rootRef.current;
    if (mode !== "doc" || !element) return;
    if (
      element.scrollTop + element.clientHeight > element.scrollHeight - 600 &&
      docLimit < docDays.length
    ) {
      setDocLimit((limit) => limit + DOC_PAGE_SIZE);
    }
    if (jumpedDate.current !== null) return;
    const box = element.getBoundingClientRect();
    const line = box.top + Math.min(160, element.clientHeight / 4);
    let current: string | null = null;
    for (const section of element.querySelectorAll<HTMLElement>("[data-note-day]")) {
      if (section.getBoundingClientRect().top > line) break;
      current = section.dataset.noteDay ?? null;
    }
    if (current !== null && current !== activeDate) setActiveDate(current);
  };

  const step = (delta: -1 | 1) => {
    if (mode === "doc") return;
    setAnchor(stepAnchor(anchor, mode, delta));
    rootRef.current?.scrollTo({ top: 0 });
  };

  const dropLineFor = (date: string) =>
    drag?.active && drag.line?.date === date
      ? drag.line
      : threadDrop?.date === date
        ? threadDrop
        : null;

  const day = (date: string, layout: DayLayout) => (
    <DaySection
      key={date}
      date={date}
      today={today}
      layout={layout}
      knownEmpty={knownEmpty(date)}
      selection={selection?.date === date ? selection : null}
      dropLine={dropLineFor(date)}
      onOpenDay={openDay}
      onConvert={(nodeId) => setConvert({ date, nodeId })}
    />
  );

  const monthDays = monthGrid(anchor);
  const monthListDays = monthDays.filter(
    (date) => sameMonth(date, anchor) && (noteDates.has(date) || date === today),
  );

  const body =
    mode === "doc" ? (
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-8",
          props.variant === "page" ? "max-w-[820px] px-10 pt-8 pb-40" : "px-5 pt-3 pb-24",
        )}
      >
        {docDays.slice(0, docLimit).map((date) => day(date, "document"))}
      </div>
    ) : mode === "day" ? (
      <div
        className={cn(
          "mx-auto flex min-h-full w-full flex-col",
          props.variant === "page" ? "max-w-[760px] px-10 pt-8" : "px-5 pt-3",
        )}
      >
        {day(anchor, "focus")}
      </div>
    ) : !grid ? (
      <div className="flex flex-col gap-6 px-5 pt-3 pb-24">
        {(mode === "week" ? weekDays(anchor) : monthListDays).map((date) => day(date, "list"))}
        {mode === "month" && monthListDays.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <T>No notes this month.</T>
          </p>
        ) : null}
      </div>
    ) : mode === "week" ? (
      <div className="grid h-full auto-rows-[minmax(220px,1fr)] grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-4">
        {weekDays(anchor).map((date) => day(date, "card"))}
      </div>
    ) : (
      <div className="flex h-full min-h-[560px] flex-col p-4">
        <div className="grid shrink-0 grid-cols-7 border-b">
          {weekDays(startOfWeek(anchor)).map((date) => (
            <div key={date} className="px-2 pb-1 text-xs text-muted-foreground">
              {dayLabels(date, today, messages).weekday}
            </div>
          ))}
        </div>
        <div
          className="grid min-h-0 flex-1 grid-cols-7 border-l"
          style={{ gridTemplateRows: `repeat(${monthDays.length / 7}, minmax(96px, 1fr))` }}
        >
          {monthDays.map((date) =>
            sameMonth(date, anchor) ? (
              day(date, "cell")
            ) : (
              <OutsideMonthCell key={date} date={date} today={today} onOpenDay={openDay} />
            ),
          )}
        </div>
      </div>
    );

  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      <ToggleGroup
        aria-label={gt("Notes view")}
        value={[mode]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "doc" || next === "day" || next === "week" || next === "month") {
            setMode(next);
            rootRef.current?.scrollTo({ top: 0 });
          }
        }}
      >
        <Toggle value="doc" aria-label={gt("Every day as one document")}>
          <T>Document</T>
        </Toggle>
        <Toggle value="day" aria-label={gt("One day")}>
          <T>Day</T>
        </Toggle>
        <Toggle value="week" aria-label={gt("The whole week")}>
          <T>Week</T>
        </Toggle>
        <Toggle value="month" aria-label={gt("The whole month")}>
          <T>Month</T>
        </Toggle>
      </ToggleGroup>
      {mode === "doc" ? null : (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Earlier", { $context: "go to the previous day, week or month" })}
          onClick={() => step(-1)}
        >
          <ChevronLeftIcon />
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={mode === "doc" ? shownActiveDate === today : inView(today, anchor, mode)}
        onClick={() => {
          if (mode === "doc") {
            jumpTo(today);
            return;
          }
          setAnchorState(null);
          rootRef.current?.scrollTo({ top: 0 });
        }}
      >
        <T>Today</T>
      </Button>
      {mode === "doc" ? null : (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Later", { $context: "go to the next day, week or month" })}
          onClick={() => step(1)}
        >
          <ChevronRightIcon />
        </Button>
      )}
      {mode === "doc" && props.variant === "page" && width >= DATE_INDEX_MIN_WIDTH ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={dateIndexOpen ? gt("Hide the date list") : gt("Show the date list")}
          aria-pressed={dateIndexOpen}
          onClick={() => setDateIndexOpen(!dateIndexOpen)}
        >
          <ListIcon />
        </Button>
      ) : null}
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger
          render={<Button size="icon-xs" variant="ghost-muted" aria-label={gt("Choose a date")} />}
        >
          <CalendarIcon />
        </PopoverTrigger>
        <PopoverPopup align="end" aria-label={gt("Choose a date")}>
          <Calendar
            mode="single"
            required
            weekStartsOn={1}
            selected={dateFromKey(mode === "doc" ? shownActiveDate : anchor)}
            defaultMonth={dateFromKey(mode === "doc" ? shownActiveDate : anchor)}
            modifiers={{ hasNote: [...noteDates].map(dateFromKey) }}
            modifiersStyles={{
              hasNote: { fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 4 },
            }}
            onSelect={(selected) => {
              setCalendarOpen(false);
              if (mode === "doc") {
                jumpTo(localDateKey(selected));
                return;
              }
              setAnchor(localDateKey(selected));
              rootRef.current?.scrollTo({ top: 0 });
            }}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );

  const title = rangeTitle(mode, anchor, today);

  return (
    <NoteThreadIndexContext value={threadIndex}>
      <NotesViewContext value={api}>
        <div className="flex min-h-0 flex-1 flex-col">
          {props.variant === "page" ? (
            <WorkspacePageHeader
              electron={isElectron}
              className="border-b border-border [&_svg]:size-4 [&_svg]:text-muted-foreground"
            >
              <NotebookPenIcon />
              <h1 className="shrink-0 font-medium text-sm">
                <T>Daily notes</T>
              </h1>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{title}</span>
              {controls}
            </WorkspacePageHeader>
          ) : (
            <div className="flex shrink-0 items-center gap-2 px-3 pt-2 pb-1 [&_svg]:size-4">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
              {controls}
            </div>
          )}
          <div ref={frameRef} className="flex min-h-0 flex-1">
            {showDateIndex ? (
              <DateIndex days={docDays} active={shownActiveDate} today={today} onJump={jumpTo} />
            ) : null}
            <div
              ref={rootRef}
              {...threadContextDropTargetProps()}
              className={cn(
                "scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain",
                (drag?.active || rangeSelecting) && "select-none",
                drag?.active && "cursor-grabbing",
              )}
              onPointerDown={onRootPointerDown}
              onScroll={onRootScroll}
              onWheel={() => {
                jumpedDate.current = null;
              }}
              onTouchMove={() => {
                jumpedDate.current = null;
              }}
            >
              <div
                ref={selectionHostRef}
                tabIndex={-1}
                aria-label={gt("Selected notes")}
                className="h-full outline-none"
                onKeyDown={onSelectionKeyDown}
                onPaste={onSelectionPaste}
              >
                {body}
              </div>
            </div>
          </div>
        </div>
        {drag?.active ? (
          <div
            className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            {drag.nodes.length > 1
              ? gt("{count, plural, one {Moving {count} note} other {Moving {count} notes}}", {
                  count: drag.nodes.length,
                })
              : nodePromptText(
                  drag.nodes[0]!,
                  (segment) => resolveMention(threadIndex, segment).title,
                ) || gt("Empty note")}
          </div>
        ) : null}
        {picker ? (
          <MentionPicker
            left={picker.left}
            top={picker.top}
            highlighted={picker.highlighted}
            candidates={mentionCandidates}
            onChoose={insertMention}
          />
        ) : null}
        {convert ? (
          <ConvertDialog
            date={convert.date}
            nodeId={convert.nodeId}
            threadIndex={threadIndex}
            onClose={() => setConvert(null)}
          />
        ) : null}
      </NotesViewContext>
    </NoteThreadIndexContext>
  );
}

/** Every date in the document, grouped by month; the one at the top of the view is marked. */
function DateIndex(props: {
  readonly days: ReadonlyArray<string>;
  readonly active: string;
  readonly today: string;
  readonly onJump: (date: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const listRef = useRef<HTMLElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the marked date visible in the index as the document scrolls
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index-date="${props.active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.active]);
  const months = new Map<string, string[]>();
  for (const date of props.days) {
    const month = date.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), date]);
  }
  return (
    <nav
      ref={listRef}
      aria-label={gt("Dates")}
      className="flex w-48 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-r border-border/70 px-3 pt-6 pb-10"
    >
      {[...months].map(([month, dates]) => (
        <div key={month} className="flex flex-col">
          <div className="px-2 pb-1 text-xs text-muted-foreground">
            {dateFromKey(`${month}-01`).toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
            })}
          </div>
          {dates.map((date) => (
            <button
              key={date}
              type="button"
              data-index-date={date}
              aria-current={date === props.active ? "location" : undefined}
              className={cn(
                "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm tabular-nums text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                date === props.active && "bg-accent/70 font-medium text-foreground",
              )}
              onClick={() => props.onJump(date)}
            >
              <span>{date.slice(5).replace("-", ".")}</span>
              <span className="text-xs text-muted-foreground/80">
                {date === props.today
                  ? gt("Today")
                  : dayLabels(date, props.today, messages).weekday}
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function splitAt(node: NoteNode, offset: number) {
  const before: NoteNode["segments"][number][] = [];
  const after: NoteNode["segments"][number][] = [];
  let position = 0;
  for (const segment of node.segments) {
    const length = segment.kind === "text" ? segment.text.length : 1;
    if (position + length <= offset) before.push(segment);
    else if (position >= offset) after.push(segment);
    else if (segment.kind === "text") {
      before.push({ kind: "text", text: segment.text.slice(0, offset - position) });
      after.push({ kind: "text", text: segment.text.slice(offset - position) });
    }
    position += length;
  }
  return [before, after] as const;
}

function filterMentionCandidates(
  index: ReadonlyMap<string, NoteThreadInfo>,
  query: string,
): NoteThreadInfo[] {
  const needle = query.trim().toLowerCase();
  return [...index.values()]
    .filter((thread) => needle === "" || thread.title.toLowerCase().includes(needle))
    .toSorted((a, b) => b.activityAt.localeCompare(a.activityAt))
    .slice(0, 8);
}

function MentionPicker(props: {
  readonly left: number;
  readonly top: number;
  readonly highlighted: number;
  readonly candidates: ReadonlyArray<NoteThreadInfo>;
  readonly onChoose: (thread: NoteThreadInfo) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const left = Math.min(props.left, window.innerWidth - 300);
  return (
    <div
      role="listbox"
      aria-label={gt("Mention a thread")}
      className="fixed z-50 w-72 overflow-hidden rounded-lg border bg-popover p-1 text-sm shadow-lg"
      style={{ left: Math.max(8, left), top: Math.min(props.top, window.innerHeight - 280) }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {props.candidates.length === 0 ? (
        <div className="px-2 py-1.5 text-muted-foreground">
          <T>No matching threads</T>
        </div>
      ) : (
        props.candidates.map((thread, index) => (
          <button
            key={`${thread.environmentId}:${thread.threadId}`}
            type="button"
            role="option"
            aria-selected={index === props.highlighted}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none",
              index === props.highlighted && "bg-accent",
            )}
            onClick={() => props.onChoose(thread)}
          >
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {messages(noteThreadStatusMessage(thread.status))}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function ConvertDialog(props: {
  readonly date: string;
  readonly nodeId: string;
  readonly threadIndex: ReadonlyMap<string, NoteThreadInfo>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const { defaultProjectRef: defaultRef, handleNewThread } = useHandleNewThread();
  const node = locate(readDayTree(props.date) ?? [], props.nodeId)?.node ?? null;
  const [prompt, setPrompt] = useState(() =>
    node ? nodePromptText(node, (segment) => resolveMention(props.threadIndex, segment).title) : "",
  );
  const [projectKey, setProjectKey] = useState(
    defaultRef ? `${defaultRef.environmentId}:${defaultRef.projectId}` : "",
  );
  const [pending, setPending] = useState(false);
  const project = projects.find((entry) => `${entry.environmentId}:${entry.id}` === projectKey);

  const start = async () => {
    if (!node || !project || prompt.trim() === "") return;
    setPending(true);
    const key = segmentsKey(node.segments);
    const started = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      prompt: prompt.trim(),
    }).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: gt("Could not start a thread."),
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    setPending(false);
    if (!started) return;
    addPendingConversion({
      date: props.date,
      segmentsKey: key,
      environmentId: project.environmentId,
      threadId: started.threadId,
      title: prompt.trim().split("\n")[0]!.slice(0, 80),
    });
    setBlockSelection(null);
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <T>Start a thread</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Opens a new thread with this note as the message. Send it from the composer; the note
              then links to the thread.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Select
              value={projectKey}
              onValueChange={(value) => value !== null && setProjectKey(value)}
            >
              <SelectTrigger aria-label={gt("Project")} size="sm">
                <SelectValue>{project?.title ?? gt("Choose a project")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projects.map((entry) => (
                  <SelectItem
                    key={`${entry.environmentId}:${entry.id}`}
                    value={`${entry.environmentId}:${entry.id}`}
                  >
                    {entry.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Textarea
              aria-label={gt("Message")}
              value={prompt}
              rows={8}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void start();
                }
              }}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={pending || !project || prompt.trim() === "" || !node}
            onClick={() => void start()}
          >
            <T>Open thread</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
