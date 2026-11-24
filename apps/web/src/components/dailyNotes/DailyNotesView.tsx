import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  CalendarIcon,
  CheckSquareIcon,
  CopyIcon,
  MessageSquarePlusIcon,
  NotebookPenIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
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
import { addPendingConversion } from "./DailyNotesBackground";
import {
  editDay,
  ensureDayLoaded,
  readDayTree,
  requestFocus,
  setBlockSelection,
  undoDay,
  useDailyNotesStore,
} from "./dailyNotesStore";
import { closeMentionPicker, useMentionPickerStore } from "./mentionPickerStore";
import { getSelectionOffsets } from "./noteDom";
import { INDENT_PX, NoteRow, NotesViewContext, type NotesViewApi } from "./NoteOutline";
import {
  cycleTodo,
  type DropTarget,
  indentNode,
  insertAtTarget,
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
  removeNodes,
  segmentsKey,
  topLevelSelection,
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

const PAGE_SIZE = 10;

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

function dayHeading(
  key: string,
  today: string,
): { kind: "today" | "yesterday" | "date"; detail: string } {
  const date = dateFromKey(key);
  const detail = date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    weekday: "long",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
  if (key === today) return { kind: "today", detail };
  const yesterday = new Date(dateFromKey(today));
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDateKey(yesterday)) return { kind: "yesterday", detail };
  return { kind: "date", detail };
}

function selectedNodes(tree: NoteTree, anchorId: string, headId: string): NoteNode[] {
  const rows = visibleRows(tree);
  const a = rows.findIndex((row) => row.node.id === anchorId);
  const b = rows.findIndex((row) => row.node.id === headId);
  if (a < 0 || b < 0) return [];
  const ids = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((row) => row.node.id));
  return topLevelSelection(tree, ids);
}

function subtreeIds(nodes: ReadonlyArray<NoteNode>, into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    into.add(node.id);
    subtreeIds(node.children, into);
  }
  return into;
}

interface DropLine {
  readonly date: string;
  readonly target: DropTarget;
  readonly top: number;
  readonly left: number;
}

/** Where a drop at (x, y) lands among a day's rows: between two rows, at the depth x points to. */
function computeDrop(
  dayElement: HTMLElement,
  date: string,
  tree: NoteTree,
  point: { x: number; y: number },
  exclude: ReadonlySet<string>,
): DropLine {
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
  const wanted = Math.round((point.x - outlineBox.left - 20) / INDENT_PX);
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
  return { date, target, top, left: depth * INDENT_PX + 20 };
}

interface BulletDrag {
  readonly date: string;
  readonly nodes: ReadonlyArray<NoteNode>;
  readonly startX: number;
  readonly startY: number;
  readonly active: boolean;
  readonly x: number;
  readonly y: number;
  readonly line: DropLine | null;
  readonly otherDay: boolean;
}

export function DailyNotesView(props: { readonly variant: "page" | "panel" }) {
  const gt = useGT();
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const today = localDateKey(new Date(`${nowMinute}:00.000Z`));
  const [anchor, setAnchor] = useState<string | null>(null);
  const top = anchor ?? today;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [convert, setConvert] = useState<{ date: string; nodeId: string } | null>(null);
  const [drag, setDrag] = useState<BulletDrag | null>(null);
  const [threadDrop, setThreadDrop] = useState<DropLine | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionHostRef = useRef<HTMLDivElement>(null);
  const threadDropRef = useRef<DropLine | null>(null);
  const dragRef = useRef<BulletDrag | null>(null);
  const updateDrag = (next: BulletDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

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
  const days = [
    top,
    ...[...noteDates].filter((date) => date < top).toSorted((a, b) => b.localeCompare(a)),
  ];
  const shownDays = days.slice(0, limit);

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
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        line: null,
        otherDay: false,
      });
    },
    chooseMention: () => {
      const choice = mentionCandidates[useMentionPickerStore.getState().picker?.highlighted ?? 0];
      if (!choice) return false;
      insertMention(choice);
      return true;
    },
    mentionCount: () => mentionCandidates.length,
    focusSelectionHost: () => selectionHostRef.current?.focus({ preventScroll: true }),
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
      {
        const dayElement = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-note-day]");
        const tree = readDayTree(current.date);
        const sameDay = dayElement?.dataset.noteDay === current.date;
        const line =
          sameDay && dayElement && tree
            ? computeDrop(
                dayElement,
                current.date,
                tree,
                { x: event.clientX, y: event.clientY },
                subtreeIds(current.nodes),
              )
            : null;
        updateDrag({
          ...current,
          active,
          x: event.clientX,
          y: event.clientY,
          line,
          otherDay: dayElement !== null && dayElement !== undefined && !sameDay,
        });
      }
    };
    const up = () => {
      const current = dragRef.current;
      updateDrag(null);
      if (!current) return;
      if (!current.active) {
        const node = current.nodes[0];
        if (node) {
          setBlockSelection({ date: current.date, anchorId: node.id, headId: node.id });
          selectionHostRef.current?.focus({ preventScroll: true });
        }
      } else if (current.line) {
        const line = current.line;
        editDay(current.date, (tree) => moveNodesTo(tree, current.nodes, line.target));
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
      const dayElement = document
        .elementFromPoint(point.x, point.y)
        ?.closest<HTMLElement>("[data-note-day]");
      const date = dayElement?.dataset.noteDay;
      const tree = date ? readDayTree(date) : null;
      threadDropRef.current =
        dayElement && date && tree ? computeDrop(dayElement, date, tree, point, new Set()) : null;
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

  const selection = useDailyNotesStore((state) => state.selection);

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
      const first = rows[0];
      const last = rows.at(-1);
      if (first && last)
        setBlockSelection({ date: current.date, anchorId: first.node.id, headId: last.node.id });
    }
  };

  const controls = (
    <div className="flex items-center gap-1">
      {top !== today ? (
        <Button size="xs" variant="ghost-muted" onClick={() => setAnchor(null)}>
          <Undo2Icon />
          <T>Back to today</T>
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
            selected={dateFromKey(top)}
            defaultMonth={dateFromKey(top)}
            modifiers={{ hasNote: [...noteDates].map(dateFromKey) }}
            modifiersStyles={{
              hasNote: { fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 4 },
            }}
            onSelect={(selected) => {
              const key = localDateKey(selected);
              setAnchor(key === today ? null : key);
              setLimit(PAGE_SIZE);
              setCalendarOpen(false);
              rootRef.current?.scrollTo({ top: 0 });
            }}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );

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
              <h1 className="min-w-0 flex-1 truncate font-medium text-sm">
                <T>Daily notes</T>
              </h1>
              {controls}
            </WorkspacePageHeader>
          ) : null}
          <div
            ref={rootRef}
            {...threadContextDropTargetProps()}
            className={cn(
              "scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain",
              drag?.active && "cursor-grabbing select-none",
            )}
            onScroll={(event) => {
              const element = event.currentTarget;
              if (
                element.scrollTop + element.clientHeight > element.scrollHeight - 400 &&
                limit < days.length
              ) {
                setLimit((value) => value + PAGE_SIZE);
              }
            }}
          >
            <div
              ref={selectionHostRef}
              tabIndex={-1}
              aria-label={gt("Selected notes")}
              className={cn(
                "mx-auto flex w-full flex-col gap-6 outline-none",
                props.variant === "page" ? "max-w-[760px] px-10 pt-8 pb-40" : "px-5 pt-3 pb-24",
              )}
              onKeyDown={onSelectionKeyDown}
            >
              {props.variant === "page" ? null : (
                <div className="-mb-3 flex justify-end">{controls}</div>
              )}
              {shownDays.map((date) => (
                <DaySection
                  key={date}
                  date={date}
                  today={today}
                  variant={props.variant}
                  selection={selection?.date === date ? selection : null}
                  dropLine={
                    drag?.active && drag.line?.date === date
                      ? drag.line
                      : threadDrop?.date === date
                        ? threadDrop
                        : null
                  }
                  onConvert={(nodeId) => setConvert({ date, nodeId })}
                />
              ))}
            </div>
          </div>
        </div>
        {drag?.active ? (
          <div
            className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            {drag.otherDay
              ? gt("Notes can''t move to another day")
              : drag.nodes.length > 1
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

function cycleSelectionTodo(date: string, nodes: ReadonlyArray<NoteNode>) {
  editDay(date, (tree) => {
    let next: NoteTree = tree;
    for (const node of nodes)
      next = updateNode(next, node.id, (current) => ({
        ...current,
        todo: cycleTodo(current.todo),
      }));
    return next;
  });
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

function DaySection(props: {
  readonly date: string;
  readonly today: string;
  readonly variant: "page" | "panel";
  readonly selection: { anchorId: string; headId: string } | null;
  readonly dropLine: DropLine | null;
  readonly onConvert: (nodeId: string) => void;
}) {
  const { date } = props;
  const day = useDailyNotesStore((state) => state.days[date]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the day's file from the server when it scrolls into the stream
  useEffect(() => {
    void ensureDayLoaded(date);
  }, [date]);
  const gt = useGT();
  const heading = dayHeading(date, props.today);
  const headingTitle =
    heading.kind === "today"
      ? gt("Today")
      : heading.kind === "yesterday"
        ? gt("Yesterday")
        : heading.detail;
  const tree = day?.status === "ready" ? day.tree : [];
  const rows = visibleRows(tree);
  const selected = props.selection
    ? selectedNodes(tree, props.selection.anchorId, props.selection.headId)
    : [];
  const highlighted = subtreeIds(selected);
  const isToday = date === props.today;

  const addFirst = () => {
    const node = makeNode();
    if (editDay(date, (value) => (value.length === 0 ? [node] : null)))
      requestFocus(date, node.id, 0);
  };

  return (
    <section data-note-day={date} className="flex flex-col gap-1.5">
      <header className="flex items-baseline gap-2">
        <h2 className={cn("font-semibold", props.variant === "page" ? "text-lg" : "text-sm")}>
          {headingTitle}
        </h2>
        {heading.kind !== "date" ? (
          <span className="text-xs text-muted-foreground">{heading.detail}</span>
        ) : null}
      </header>
      <div data-note-outline="" className="relative pl-4">
        {day === undefined || day.status === "loading" ? (
          <div className="h-6 text-sm text-muted-foreground/60">…</div>
        ) : day.status === "error" ? (
          <div className="text-sm text-muted-foreground">
            <T>Could not load this day.</T>
          </div>
        ) : rows.length === 0 ? (
          <button
            type="button"
            className="flex h-6 w-full cursor-text items-center pl-5 text-left text-sm text-muted-foreground/60 outline-none"
            onClick={addFirst}
            onFocus={addFirst}
          >
            {isToday ? gt("Write something…") : gt("Nothing written this day.")}
          </button>
        ) : (
          rows.map((row, index) => (
            <NoteRow
              key={row.node.id}
              date={date}
              node={row.node}
              depth={row.depth}
              selected={highlighted.has(row.node.id)}
              placeholder={
                index === 0 && rows.length === 1 && isToday ? gt("Write something…") : null
              }
            />
          ))
        )}
        {props.dropLine ? (
          <div
            className="pointer-events-none absolute right-0 h-0.5 rounded-full bg-primary"
            style={{ top: props.dropLine.top - 1, left: props.dropLine.left + 16 }}
          />
        ) : null}
        {selected.length > 0 ? (
          <SelectionBar date={date} nodes={selected} onConvert={props.onConvert} />
        ) : null}
      </div>
    </section>
  );
}

function SelectionBar(props: {
  readonly date: string;
  readonly nodes: ReadonlyArray<NoteNode>;
  readonly onConvert: (nodeId: string) => void;
}) {
  const gt = useGT();
  const ref = useRef<HTMLDivElement>(null);
  const firstId = props.nodes[0]?.id;
  const [top, setTop] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the bar above the first selected row, measured from the DOM
  useEffect(() => {
    const outline = ref.current?.parentElement;
    const row = outline?.querySelector<HTMLElement>(`[data-note-row][data-node-id="${firstId}"]`);
    if (!outline || !row) return;
    setTop(row.getBoundingClientRect().top - outline.getBoundingClientRect().top);
  }, [firstId]);
  const keepFocus = (event: ReactPointerEvent) => event.preventDefault();
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={gt("Selected notes")}
      className="absolute right-0 z-10 flex -translate-y-full items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm"
      style={{ top: (top ?? 0) - 4 }}
      onPointerDown={keepFocus}
    >
      <Button size="xs" variant="ghost" onClick={() => cycleSelectionTodo(props.date, props.nodes)}>
        <CheckSquareIcon />
        <T>To-do</T>
      </Button>
      {props.nodes.length === 1 ? (
        <Button size="xs" variant="ghost" onClick={() => props.onConvert(props.nodes[0]!.id)}>
          <MessageSquarePlusIcon />
          <T>Start a thread</T>
        </Button>
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={gt("Copy")}
        onClick={() => void navigator.clipboard.writeText(nodesToMarkdown(props.nodes))}
      >
        <CopyIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-destructive"
        aria-label={gt("Delete")}
        onClick={() => {
          editDay(props.date, (tree) =>
            removeNodes(
              tree,
              props.nodes.map((node) => node.id),
            ),
          );
          setBlockSelection(null);
        }}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
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
    const text = prompt.trim();
    const started = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      prompt: text,
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
      title: text.split("\n")[0]!.slice(0, 80),
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
