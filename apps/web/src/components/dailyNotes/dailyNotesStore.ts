import type { DailyNote, DailyNoteDate, DailyNotesSnapshot } from "@t3tools/contracts";
import { create } from "zustand";

import { type NoteTree, parseNote, serializeNote } from "./noteModel";

export interface DailyNotesIo {
  readonly read: (date: DailyNoteDate) => Promise<DailyNote | null>;
  readonly write: (date: DailyNoteDate, content: string) => Promise<DailyNote | null>;
}

/** A caret to restore with an undo step. */
export interface NoteCaret {
  readonly id: string;
  readonly offset: number;
}

interface HistoryEntry {
  readonly tree: NoteTree;
  readonly caret: NoteCaret | null;
}

export interface DayState {
  readonly status: "loading" | "ready" | "error";
  readonly tree: NoteTree;
  /** mtime of the file content `tree` was last synced with. */
  readonly syncedAt: string | null;
  readonly syncedContent: string;
  readonly undo: ReadonlyArray<HistoryEntry>;
  readonly redo: ReadonlyArray<HistoryEntry>;
}

/** Where the caret should go after an edit; consumed by the row that owns `nodeId`. */
export interface FocusRequest {
  readonly date: string;
  readonly nodeId: string;
  readonly offset: number | "end" | "start";
  readonly nonce: number;
}

export interface BlockSelection {
  readonly date: string;
  readonly anchorId: string;
  readonly headId: string;
}

interface DailyNotesState {
  readonly days: Readonly<Record<string, DayState>>;
  readonly focus: FocusRequest | null;
  readonly selection: BlockSelection | null;
}

export const useDailyNotesStore = create<DailyNotesState>(() => ({
  days: {},
  focus: null,
  selection: null,
}));

let io: DailyNotesIo | null = null;
const waitingForIo = new Set<string>();
export function setDailyNotesIo(next: DailyNotesIo | null) {
  io = next;
  if (io === null) return;
  for (const date of waitingForIo) void ensureDayLoaded(date);
  waitingForIo.clear();
}

const SAVE_DELAY_MS = 500;
const HISTORY_LIMIT = 200;
const COALESCE_MS = 1200;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const savesInFlight = new Map<string, Promise<void>>();
const lastCoalesce = new Map<string, { key: string; at: number }>();
let focusNonce = 0;

/** The day whose editor holds the caret; external file changes wait until it blurs. */
let editingDate: string | null = null;
export function setEditingDate(date: string | null) {
  editingDate = date;
}

function getDay(date: string): DayState | undefined {
  return useDailyNotesStore.getState().days[date];
}

function setDay(date: string, day: DayState) {
  useDailyNotesStore.setState((state) => ({ days: { ...state.days, [date]: day } }));
}

export function requestFocus(date: string, nodeId: string, offset: FocusRequest["offset"]) {
  focusNonce += 1;
  useDailyNotesStore.setState({
    focus: { date, nodeId, offset, nonce: focusNonce },
    selection: null,
  });
}

export function clearFocusRequest(nonce: number) {
  if (useDailyNotesStore.getState().focus?.nonce === nonce)
    useDailyNotesStore.setState({ focus: null });
}

export function setBlockSelection(selection: BlockSelection | null) {
  useDailyNotesStore.setState({ selection });
}

/** `knownEmpty`: the server snapshot lists no file for this day, so there is nothing to read. */
export async function ensureDayLoaded(date: string, knownEmpty = false) {
  if (getDay(date) !== undefined) return;
  if (knownEmpty) {
    setDay(date, {
      status: "ready",
      tree: [],
      syncedAt: null,
      syncedContent: "",
      undo: [],
      redo: [],
    });
    return;
  }
  if (io === null) {
    waitingForIo.add(date);
    return;
  }
  setDay(date, {
    status: "loading",
    tree: [],
    syncedAt: null,
    syncedContent: "",
    undo: [],
    redo: [],
  });
  await reloadDay(date);
}

const readFailures = new Map<string, number>();

async function reloadDay(date: string) {
  if (io === null) return;
  const note = await io.read(date).catch(() => null);
  const current = getDay(date);
  if (current === undefined) return;
  if (note === null) {
    if (current.status === "ready") return;
    // The connection is often still coming up on the first read; keep trying, slower each time.
    const failures = (readFailures.get(date) ?? 0) + 1;
    readFailures.set(date, failures);
    if (failures >= 4 && current.status === "loading")
      setDay(date, { ...current, status: "error" });
    setTimeout(() => void reloadDay(date), Math.min(30_000, 500 * 2 ** failures));
    return;
  }
  readFailures.delete(date);
  // A local edit landed while this read was in flight; it wins and will be written back.
  if (current.status === "ready" && serializeNote(current.tree) !== current.syncedContent) return;
  setDay(date, {
    ...current,
    status: "ready",
    tree: parseNote(note.content),
    syncedAt: note.updatedAt,
    syncedContent: note.content,
  });
}

/** Folds in changes made outside this client (another window, an editor, an agent). */
export function applyServerSnapshot(snapshot: DailyNotesSnapshot) {
  const updatedAtByDate = new Map(snapshot.days.map((day) => [day.date, day.updatedAt]));
  for (const [date, day] of Object.entries(useDailyNotesStore.getState().days)) {
    if (day.status !== "ready" || saveTimers.has(date) || savesInFlight.has(date)) continue;
    if (date === editingDate) continue;
    const updatedAt = updatedAtByDate.get(date) ?? null;
    if (updatedAt === day.syncedAt) continue;
    if (updatedAt === null && day.syncedContent.trim() === "") continue;
    void reloadDay(date);
  }
}

function scheduleSave(date: string) {
  const existing = saveTimers.get(date);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    date,
    setTimeout(() => {
      saveTimers.delete(date);
      void saveDay(date);
    }, SAVE_DELAY_MS),
  );
}

async function saveDay(date: string): Promise<void> {
  const previous = savesInFlight.get(date);
  if (previous) await previous;
  const day = getDay(date);
  if (!day || io === null) return;
  const content = serializeNote(day.tree);
  if (content === day.syncedContent) return;
  const run = (async () => {
    const result = await io!.write(date, content).catch(() => null);
    const latest = getDay(date);
    if (result === null) {
      setTimeout(() => scheduleSave(date), 3_000);
      return;
    }
    if (latest) setDay(date, { ...latest, syncedAt: result.updatedAt, syncedContent: content });
  })();
  savesInFlight.set(date, run);
  try {
    await run;
  } finally {
    if (savesInFlight.get(date) === run) savesInFlight.delete(date);
  }
}

export function flushDailyNotes() {
  for (const [date, timer] of saveTimers) {
    clearTimeout(timer);
    saveTimers.delete(date);
    void saveDay(date);
  }
}

export interface EditOptions {
  /** Consecutive edits with the same key within a moment share one undo step (typing). */
  readonly coalesceKey?: string;
  /** Where the caret was before the edit; undo puts it back there. */
  readonly caret?: NoteCaret | null;
}

export function editDay(
  date: string,
  update: (tree: NoteTree) => NoteTree | null,
  options: EditOptions = {},
): boolean {
  const day = getDay(date);
  if (!day || day.status !== "ready") return false;
  const next = update(day.tree);
  if (next === null || next === day.tree) return false;
  const now = Date.now();
  const previous = lastCoalesce.get(date);
  const coalesce =
    options.coalesceKey !== undefined &&
    previous?.key === options.coalesceKey &&
    now - previous.at < COALESCE_MS;
  if (options.coalesceKey !== undefined)
    lastCoalesce.set(date, { key: options.coalesceKey, at: now });
  else lastCoalesce.delete(date);
  const undo = coalesce
    ? day.undo
    : [...day.undo, { tree: day.tree, caret: options.caret ?? null }].slice(-HISTORY_LIMIT);
  setDay(date, { ...day, tree: next, undo, redo: [] });
  scheduleSave(date);
  return true;
}

export function undoDay(date: string, direction: "undo" | "redo"): NoteCaret | null {
  const day = getDay(date);
  if (!day) return null;
  const from = direction === "undo" ? day.undo : day.redo;
  const entry = from.at(-1);
  if (!entry) return null;
  const current: HistoryEntry = { tree: day.tree, caret: entry.caret };
  lastCoalesce.delete(date);
  setDay(date, {
    ...day,
    tree: entry.tree,
    undo: direction === "undo" ? day.undo.slice(0, -1) : [...day.undo, current],
    redo: direction === "undo" ? [...day.redo, current] : day.redo.slice(0, -1),
  });
  scheduleSave(date);
  return entry.caret;
}

export function readDayTree(date: string): NoteTree | null {
  const day = getDay(date);
  return day?.status === "ready" ? day.tree : null;
}

/** Edits a day that may not be loaded yet, e.g. from a conversion that finished elsewhere. */
export async function editDayWhenLoaded(
  date: string,
  update: (tree: NoteTree) => NoteTree | null,
): Promise<boolean> {
  await ensureDayLoaded(date);
  const day = getDay(date);
  if (day?.status === "loading") await reloadDay(date);
  return editDay(date, update);
}
