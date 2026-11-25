import {
  DAILY_NOTE_MAX_CHARS,
  type DailyNote,
  type DailyNoteDate,
  DailyNoteError,
  type DailyNoteDay,
  type DailyNoteEditInput,
  type DailyNoteVersioned,
  type DailyNoteWriteInput,
  type DailyNotesBrowseInput,
  type DailyNotesBrowseResult,
  type DailyNotesSnapshot,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeLines } from "@t3tools/shared/lineMerge";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_DAYS = 5000;
/** How much note text one agent read returns before listing the rest by date. */
const BROWSE_CHARS = 40_000;
const MAX_MATCHES = 100;

/** Changes whenever the content does; agents pass it back to replace a whole day safely. */
export function noteVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function countOccurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) count++;
  return count;
}

function excerpt(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function resolveDailyNotesDirectory(
  setting: string,
  baseDir: string,
  path: Path.Path,
  home: string,
): string {
  if (setting === "") return path.join(baseDir, "notes");
  return path.resolve(baseDir, expandHomePath(setting, home));
}

interface ScannedFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly blank: boolean;
}

export class DailyNotes extends Context.Service<
  DailyNotes,
  {
    readonly current: Effect.Effect<DailyNotesSnapshot>;
    /** Emits the current days, then every change in the notes folder. */
    readonly streamChanges: Stream.Stream<DailyNotesSnapshot>;
    readonly read: (date: DailyNoteDate) => Effect.Effect<DailyNote, DailyNoteError>;
    readonly write: (input: DailyNoteWriteInput) => Effect.Effect<DailyNote, DailyNoteError>;
    /** What an agent reads: today and recent days, a date range, or lines matching a query. */
    readonly browse: (
      input: DailyNotesBrowseInput,
    ) => Effect.Effect<DailyNotesBrowseResult, DailyNoteError>;
    /** An agent's edit of one day, applied to the file as it is now. */
    readonly edit: (input: DailyNoteEditInput) => Effect.Effect<DailyNoteVersioned, DailyNoteError>;
  }
>()("t3/dailyNotes/DailyNotes") {}

interface Published {
  readonly seq: number;
  readonly snapshot: DailyNotesSnapshot;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;

  const directoryFor = (setting: string) =>
    resolveDailyNotesDirectory(setting, config.baseDir, path, home);
  const initialSettings = yield* settingsService.getSettings.pipe(Effect.option);
  const directory = yield* Ref.make(
    directoryFor(initialSettings._tag === "Some" ? initialSettings.value.dailyNotesDirectory : ""),
  );

  const changes = yield* PubSub.sliding<Published>(1);
  const published = yield* Ref.make<Published>({
    seq: 0,
    snapshot: { directory: yield* Ref.get(directory), days: [] },
  });
  const refreshSemaphore = yield* Semaphore.make(1);
  const writeSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const watcher = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  // Whitespace-only days are hidden, which needs their content; unchanged files skip the read.
  const scanned = new Map<string, ScannedFile>();

  const scan = Effect.fn("DailyNotes.scan")(function* (root: string) {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    const names = entries
      .filter((entry) => DAY_FILE.test(entry))
      .toSorted((a, b) => (a < b ? 1 : -1));
    const days: Array<DailyNoteDay> = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (days.length >= MAX_DAYS) break;
      const file = path.join(root, name);
      seen.add(file);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (info._tag === "None" || info.value.type !== "File") continue;
      const mtime = Option.getOrUndefined(info.value.mtime);
      const mtimeMs = mtime?.getTime() ?? 0;
      const size = Number(info.value.size);
      const cached = scanned.get(file);
      const blank =
        cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size
          ? cached.blank
          : size === 0 ||
            (yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))).trim() === "";
      scanned.set(file, { mtimeMs, size, blank });
      if (!blank) days.push({ date: name.slice(0, 10), updatedAt: mtime?.toISOString() ?? "" });
    }
    for (const file of scanned.keys()) if (!seen.has(file)) scanned.delete(file);
    return { directory: root, days } satisfies DailyNotesSnapshot;
  });

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* scan(yield* Ref.get(directory));
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, Published], Published] => {
          if (Equal.equals(previous.snapshot, snapshot)) return [[false, previous], previous];
          const updated = { seq: previous.seq + 1, snapshot };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  // A missing folder has nothing to watch; the first write creates it and watches again.
  const watch = Effect.fn("DailyNotes.watch")(function* () {
    const previous = yield* Ref.getAndSet(watcher, undefined);
    if (previous !== undefined) yield* Fiber.interrupt(previous);
    const root = yield* Ref.get(directory);
    const info = yield* fs.stat(root).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "Directory") return;
    const fiber = yield* fs.watch(root).pipe(
      Stream.debounce(Duration.millis(150)),
      Stream.runForEach(() => refresh.pipe(Effect.ignoreCause({ log: true }))),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
    );
    yield* Ref.set(watcher, fiber);
  });

  const fileFor = (root: string, date: DailyNoteDate) => path.join(root, `${date}.md`);
  const fail = (message: string) => (cause: unknown) => new DailyNoteError({ message, cause });

  const read = Effect.fn("DailyNotes.read")(function* (date: DailyNoteDate) {
    const file = fileFor(yield* Ref.get(directory), date);
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") {
      return { date, content: "", updatedAt: null } satisfies DailyNote;
    }
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(fail(`Could not read the note for ${date}.`)));
    return {
      date,
      content: text.length > DAILY_NOTE_MAX_CHARS ? text.slice(0, DAILY_NOTE_MAX_CHARS) : text,
      updatedAt: Option.getOrUndefined(info.value.mtime)?.toISOString() ?? null,
    } satisfies DailyNote;
  });

  const readText = Effect.fn("DailyNotes.readText")(function* (date: DailyNoteDate) {
    return (yield* read(date)).content;
  });

  const store = Effect.fn("DailyNotes.store")(function* (date: DailyNoteDate, content: string) {
    const root = yield* Ref.get(directory);
    const file = fileFor(root, date);
    if (content.trim().length === 0) {
      yield* fs
        .remove(file, { force: true })
        .pipe(Effect.mapError(fail(`Could not delete the note for ${date}.`)));
      yield* refresh;
      return { date, content: "", updatedAt: null } satisfies DailyNote;
    }
    const rootExisted = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
    yield* writeFileStringAtomically({ filePath: file, contents: content }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.mapError(fail(`Could not save the note for ${date}.`)),
    );
    const info = yield* fs
      .stat(file)
      .pipe(Effect.mapError(fail(`Could not read back the note for ${date}.`)));
    if (!rootExisted) yield* watch();
    yield* refresh;
    return {
      date,
      content,
      updatedAt: Option.getOrUndefined(info.mtime)?.toISOString() ?? null,
    } satisfies DailyNote;
  });

  const write = Effect.fn("DailyNotes.write")(function* (input: DailyNoteWriteInput) {
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (input.base === undefined) return yield* store(input.date, input.content);
        const current = yield* readText(input.date);
        const content =
          current === input.base ? input.content : mergeLines(input.base, input.content, current);
        return yield* store(input.date, content);
      }),
    );
  });

  const edit = Effect.fn("DailyNotes.edit")(function* (input: DailyNoteEditInput) {
    const refuse = (message: string) => Effect.fail(new DailyNoteError({ message }));
    const edits = input.edits ?? [];
    if (input.content !== undefined && (edits.length > 0 || input.append !== undefined))
      return yield* refuse("Pass `content` alone, or `edits` and `append` without it.");
    if (input.content === undefined && edits.length === 0 && input.append === undefined)
      return yield* refuse("Nothing to change: pass `edits`, `append`, or `content`.");
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readText(input.date);
        let next = current;
        if (input.content !== undefined) {
          if (current.trim() !== "" && input.version !== noteVersion(current))
            return yield* refuse(
              `The note for ${input.date} changed since you read it, or no \`version\` was given. Read it again, then pass its version.`,
            );
          next = input.content;
        }
        for (const { oldText, newText } of edits) {
          const count = countOccurrences(next, oldText);
          if (count !== 1)
            return yield* refuse(
              count === 0
                ? `Not found in ${input.date}: "${excerpt(oldText)}". Read the day again; oldText must match exactly, indentation included.`
                : `"${excerpt(oldText)}" appears ${count} times in ${input.date}. Include more of the surrounding lines.`,
            );
          next = next.replace(oldText, () => newText);
        }
        if (input.append !== undefined && input.append.trim() !== "") {
          const head = next === "" || next.endsWith("\n") ? next : `${next}\n`;
          next = `${head}${input.append.replace(/\n*$/, "")}\n`;
        }
        const saved = next === current ? current : (yield* store(input.date, next)).content;
        return { date: input.date, version: noteVersion(saved), content: saved };
      }),
    );
  });

  const browse = Effect.fn("DailyNotes.browse")(function* (input: DailyNotesBrowseInput) {
    const today = DateTime.formatIsoDate(
      yield* DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone),
    );
    const snapshot = (yield* refresh).snapshot;
    const withNotes = snapshot.days.map((day) => day.date);
    const versioned = (date: DailyNoteDate) =>
      Effect.map(readText(date), (content) => ({ date, version: noteVersion(content), content }));
    if (input.query !== undefined) {
      const needle = input.query.toLowerCase();
      const matches: Array<{ date: DailyNoteDate; line: number; text: string }> = [];
      for (const date of withNotes) {
        if (matches.length >= MAX_MATCHES) break;
        const lines = (yield* readText(date)).split("\n");
        lines.forEach((text, index) => {
          if (matches.length < MAX_MATCHES && text.toLowerCase().includes(needle))
            matches.push({ date, line: index + 1, text });
        });
      }
      return { folder: snapshot.directory, today, days: [], moreDates: [], matches };
    }
    const candidates =
      input.date !== undefined
        ? [input.date]
        : input.from !== undefined || input.to !== undefined
          ? withNotes.filter(
              (date) =>
                (input.from === undefined || date >= input.from) &&
                (input.to === undefined || date <= input.to),
            )
          : [today, ...withNotes.filter((date) => date !== today)].toSorted((a, b) =>
              a < b ? 1 : -1,
            );
    const days: Array<DailyNoteVersioned> = [];
    let used = 0;
    let index = 0;
    for (; index < candidates.length; index++) {
      const day = yield* versioned(candidates[index]!);
      if (days.length > 0 && used + day.content.length > BROWSE_CHARS) break;
      days.push(day);
      used += day.content.length;
    }
    return { folder: snapshot.directory, today, days, moreDates: candidates.slice(index) };
  });

  const settingsChanges = yield* settingsService.subscribeChanges;
  yield* watch();
  yield* refresh;
  yield* Stream.runForEach(settingsChanges, (settings) =>
    Effect.gen(function* () {
      const next = directoryFor(settings.dailyNotesDirectory);
      if (next === (yield* Ref.get(directory))) return;
      yield* writeSemaphore.withPermits(1)(
        Ref.set(directory, next).pipe(Effect.andThen(watch()), Effect.andThen(refresh)),
      );
    }).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    current: Effect.map(refresh, (state) => state.snapshot),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* refresh;
          return Stream.concat(
            Stream.make(initial.snapshot),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > initial.seq),
              Stream.map((update) => update.snapshot),
            ),
          );
        }),
      );
    },
    read,
    write,
    browse,
    edit,
  } satisfies DailyNotes["Service"];
});

export const layer = Layer.effect(DailyNotes, make);
