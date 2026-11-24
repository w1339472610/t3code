import {
  DAILY_NOTE_MAX_CHARS,
  type DailyNote,
  type DailyNoteDate,
  DailyNoteError,
  type DailyNoteDay,
  type DailyNoteWriteInput,
  type DailyNotesSnapshot,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

  const write = Effect.fn("DailyNotes.write")(function* (input: DailyNoteWriteInput) {
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const root = yield* Ref.get(directory);
        const file = fileFor(root, input.date);
        if (input.content.trim().length === 0) {
          yield* fs
            .remove(file, { force: true })
            .pipe(Effect.mapError(fail(`Could not delete the note for ${input.date}.`)));
          yield* refresh;
          return { date: input.date, content: "", updatedAt: null } satisfies DailyNote;
        }
        const rootExisted = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
        yield* writeFileStringAtomically({ filePath: file, contents: input.content }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.mapError(fail(`Could not save the note for ${input.date}.`)),
        );
        const info = yield* fs
          .stat(file)
          .pipe(Effect.mapError(fail(`Could not read back the note for ${input.date}.`)));
        if (!rootExisted) yield* watch();
        yield* refresh;
        return {
          date: input.date,
          content: input.content,
          updatedAt: Option.getOrUndefined(info.mtime)?.toISOString() ?? null,
        } satisfies DailyNote;
      }),
    );
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
  } satisfies DailyNotes["Service"];
});

export const layer = Layer.effect(DailyNotes, make);
