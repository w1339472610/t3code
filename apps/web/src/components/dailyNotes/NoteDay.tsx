import { T, msg, useGT, useMessages } from "gt-react";
import { CheckSquareIcon, CopyIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";

import type { MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  editDay,
  ensureDayLoaded,
  requestFocus,
  setBlockSelection,
  useDailyNotesStore,
} from "./dailyNotesStore";
import { dateFromKey, localDateKey } from "./noteDates";
import { indentFor, type NoteDensity, NoteRow } from "./NoteOutline";
import {
  cycleTodo,
  type DropTarget,
  makeNode,
  type NoteNode,
  type NoteTree,
  nodesToMarkdown,
  removeNodes,
  segmentsLength,
  topLevelSelection,
  updateNode,
  visibleRows,
} from "./noteModel";

/**
 * document: one day in the continuous document; focus: the one day in day view; card: a week
 * day; cell: a month day; list: narrow week or month.
 */
export type DayLayout = "document" | "focus" | "card" | "cell" | "list";

export interface DropLine {
  readonly date: string;
  readonly target: DropTarget;
  readonly top: number;
  readonly left: number;
}

const BULLET_PX: Record<NoteDensity, number> = { normal: 20, compact: 16, document: 24 };

export function selectedNodes(tree: NoteTree, anchorId: string, headId: string): NoteNode[] {
  const rows = visibleRows(tree);
  const a = rows.findIndex((row) => row.node.id === anchorId);
  const b = rows.findIndex((row) => row.node.id === headId);
  if (a < 0 || b < 0) return [];
  const ids = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((row) => row.node.id));
  return topLevelSelection(tree, ids);
}

export function subtreeIds(nodes: ReadonlyArray<NoteNode>, into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    into.add(node.id);
    subtreeIds(node.children, into);
  }
  return into;
}

export function cycleSelectionTodo(date: string, nodes: ReadonlyArray<NoteNode>) {
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

/** Clicking below a day's notes keeps writing: reuse a trailing empty line or add one. */
function appendAtEnd(date: string) {
  const day = useDailyNotesStore.getState().days[date];
  if (day?.status !== "ready") return;
  const last = day.tree.at(-1);
  if (
    last &&
    last.children.length === 0 &&
    last.todo === null &&
    segmentsLength(last.segments) === 0
  ) {
    requestFocus(date, last.id, 0);
    return;
  }
  const node = makeNode();
  if (editDay(date, (tree) => [...tree, node])) requestFocus(date, node.id, 0);
}

export function dayLabels(key: string, today: string, resolve: MessageResolver) {
  const date = dateFromKey(key);
  const yesterday = dateFromKey(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    relative:
      key === today
        ? resolve(msg("Today"))
        : key === localDateKey(yesterday)
          ? resolve(msg("Yesterday"))
          : null,
    long: date.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      weekday: "long",
      ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    }),
    weekday: date.toLocaleDateString(undefined, { weekday: "short" }),
    short: date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }),
    dayOfMonth: String(date.getDate()),
  };
}

export function DaySection(props: {
  readonly date: string;
  readonly today: string;
  readonly layout: DayLayout;
  /** The server lists no file for this day, so it opens empty without a read. */
  readonly knownEmpty: boolean;
  readonly selection: { anchorId: string; headId: string } | null;
  readonly dropLine: DropLine | null;
  readonly onOpenDay: (date: string) => void;
  readonly onConvert: (nodeId: string) => void;
}) {
  const { date, layout } = props;
  const day = useDailyNotesStore((state) => state.days[date]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the day's file from the server when the day comes into view
  useEffect(() => {
    void ensureDayLoaded(date, props.knownEmpty);
  }, [date, props.knownEmpty]);
  const density: NoteDensity =
    layout === "cell" ? "compact" : layout === "document" ? "document" : "normal";
  const gt = useGT();
  const labels = dayLabels(date, props.today, useMessages());
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

  const keepWriting = (event: ReactPointerEvent) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.preventDefault();
    appendAtEnd(date);
  };

  const outline = (
    <div data-note-outline="" className="relative pl-4">
      {day === undefined || day.status === "loading" ? (
        <div className="h-6 text-sm text-muted-foreground/60">…</div>
      ) : day.status === "error" ? (
        <div className="text-sm text-muted-foreground">
          <T>Could not load this day.</T>
        </div>
      ) : rows.length === 0 ? (
        layout === "cell" ? null : (
          <button
            type="button"
            className={cn(
              "flex w-full cursor-text items-center text-left text-muted-foreground/60 outline-none",
              layout === "document" ? "h-7 pl-6 text-base" : "h-6 pl-5 text-sm",
            )}
            onClick={addFirst}
          >
            {isToday || layout === "focus" || layout === "document"
              ? gt("Write something…")
              : gt("Nothing yet")}
          </button>
        )
      ) : (
        rows.map((row, index) => (
          <NoteRow
            key={row.node.id}
            date={date}
            node={row.node}
            depth={row.depth}
            density={density}
            ordinal={row.ordinal}
            selected={highlighted.has(row.node.id)}
            placeholder={
              index === 0 && rows.length === 1 && layout !== "cell" ? gt("Write something…") : null
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
    </div>
  );

  const bar =
    selected.length > 0 ? (
      <SelectionBar date={date} nodes={selected} onConvert={props.onConvert} />
    ) : null;

  const dataProps = {
    "data-note-day": date,
    "data-indent": indentFor(density),
    "data-bullet": BULLET_PX[density],
  };

  if (layout === "document") {
    return (
      <section {...dataProps} className="flex scroll-mt-4 flex-col gap-2">
        <header className="flex items-baseline gap-2.5">
          <h2 className="font-semibold text-2xl tabular-nums tracking-tight">
            {date.replaceAll("-", ".")}
          </h2>
          <span className="text-sm text-muted-foreground">{labels.weekday}</span>
          {labels.relative ? <span className="text-sm text-primary">{labels.relative}</span> : null}
        </header>
        {outline}
        <div aria-hidden className="min-h-3 cursor-text" onPointerDown={keepWriting} />
        {bar}
      </section>
    );
  }

  if (layout === "focus") {
    return (
      <section {...dataProps} className="flex min-h-full flex-1 flex-col gap-1.5">
        <header className="flex items-baseline gap-2">
          <h2 className="font-semibold text-lg">{labels.relative ?? labels.long}</h2>
          {labels.relative ? (
            <span className="text-xs text-muted-foreground">{labels.long}</span>
          ) : null}
        </header>
        {outline}
        <div aria-hidden className="min-h-32 flex-1 cursor-text" onPointerDown={keepWriting} />
        {bar}
      </section>
    );
  }

  if (layout === "list") {
    return (
      <section {...dataProps} className="flex flex-col gap-1">
        <DayHeaderButton onClick={() => props.onOpenDay(date)}>
          <span className={cn("font-semibold text-sm", isToday && "text-primary")}>
            {labels.relative ?? labels.long}
          </span>
          {labels.relative ? (
            <span className="text-xs text-muted-foreground">{labels.long}</span>
          ) : null}
        </DayHeaderButton>
        {outline}
        {bar}
      </section>
    );
  }

  if (layout === "card") {
    return (
      <section
        {...dataProps}
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card/60",
          isToday ? "border-primary/40" : "border-border/70",
        )}
      >
        <DayHeaderButton className="px-3 pt-2.5 pb-1.5" onClick={() => props.onOpenDay(date)}>
          <span className={cn("font-semibold text-sm", isToday && "text-primary")}>
            {labels.weekday}
          </span>
          <span className="text-xs text-muted-foreground">{labels.short}</span>
          {isToday ? (
            <span className="text-xs text-primary">
              <T>Today</T>
            </span>
          ) : null}
        </DayHeaderButton>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-2">
          {outline}
          <div aria-hidden className="min-h-6 flex-1 cursor-text" onPointerDown={keepWriting} />
        </div>
        {bar}
      </section>
    );
  }

  return (
    <section {...dataProps} className="flex min-h-0 min-w-0 flex-col border-r border-b px-1 pt-1">
      <div className="flex shrink-0">
        <button
          type="button"
          aria-label={labels.long}
          className={cn(
            "flex h-5 min-w-5 cursor-pointer items-center justify-center rounded-full px-1 text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            isToday && "bg-primary font-medium text-primary-foreground hover:bg-primary/90",
          )}
          onClick={() => props.onOpenDay(date)}
        >
          {labels.dayOfMonth}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-1">
        {outline}
        <div aria-hidden className="min-h-3 flex-1 cursor-text" onPointerDown={keepWriting} />
      </div>
      {bar}
    </section>
  );
}

function DayHeaderButton(props: {
  readonly className?: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-fit shrink-0 cursor-pointer items-baseline gap-2 rounded-md text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        props.className,
      )}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** A day before or after the shown month, kept only so the grid lines up by weekday. */
export function OutsideMonthCell(props: {
  readonly date: string;
  readonly today: string;
  readonly onOpenDay: (date: string) => void;
}) {
  const labels = dayLabels(props.date, props.today, useMessages());
  return (
    <div className="flex min-w-0 flex-col border-r border-b bg-muted/30 px-1 pt-1">
      <button
        type="button"
        aria-label={labels.long}
        className="flex h-5 w-fit min-w-5 cursor-pointer items-center justify-center rounded-full px-1 text-xs text-muted-foreground/60 tabular-nums outline-none hover:bg-accent"
        onClick={() => props.onOpenDay(props.date)}
      >
        {labels.dayOfMonth}
      </button>
    </div>
  );
}

function SelectionBar(props: {
  readonly date: string;
  readonly nodes: ReadonlyArray<NoteNode>;
  readonly onConvert: (nodeId: string) => void;
}) {
  const gt = useGT();
  const firstId = props.nodes[0]?.id;
  const lastId = props.nodes.at(-1)?.id;
  const [place, setPlace] = useState<{ x: number; y: number; below: boolean } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the bar to the selected rows, which move with every scroll container they sit in
  useEffect(() => {
    const day = document.querySelector<HTMLElement>(`[data-note-day="${props.date}"]`);
    const rowOf = (id: string | undefined) =>
      day?.querySelector<HTMLElement>(`[data-note-row][data-node-id="${id}"]`);
    const measure = () => {
      const first = rowOf(firstId);
      const last = rowOf(lastId) ?? first;
      if (!first || !last) return;
      const top = first.getBoundingClientRect();
      const below = top.top < 96;
      setPlace({
        x: top.right,
        y: below ? last.getBoundingClientRect().bottom + 4 : top.top - 4,
        below,
      });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [props.date, firstId, lastId]);
  const keepFocus = (event: ReactPointerEvent) => event.preventDefault();
  if (!place) return null;
  return (
    <div
      role="toolbar"
      aria-label={gt("Selected notes")}
      className="fixed z-30 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm"
      style={{
        left: Math.max(8, place.x),
        top: place.y,
        transform: place.below ? "translateX(-100%)" : "translate(-100%, -100%)",
      }}
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
