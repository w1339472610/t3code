import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DailyNotes from "./DailyNotes.ts";

const withNotes = <A, E>(
  body: (
    baseDir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | DailyNotes.DailyNotes>,
  options: {
    readonly dailyNotesDirectory?: string;
    /** Files under `<baseDir>/notes`; a name ending in `/` makes a folder. */
    readonly seed?: Readonly<Record<string, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-notes-" });
    const seedDir = `${baseDir}/notes`;
    for (const [name, contents] of Object.entries(options.seed ?? {})) {
      if (name.endsWith("/")) {
        yield* fs.makeDirectory(`${seedDir}/${name}`, { recursive: true });
      } else {
        yield* fs.makeDirectory(seedDir, { recursive: true });
        yield* fs.writeFileString(`${seedDir}/${name}`, contents);
      }
    }
    const layer = DailyNotes.layer.pipe(
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          dailyNotesDirectory: options.dailyNotesDirectory ?? "",
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    return yield* body(baseDir).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.HomeDirectory, baseDir),
    );
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("daily notes", (it) => {
  it.effect("lists only non-blank YYYY-MM-DD.md files, newest first", () =>
    withNotes(
      (baseDir) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const snapshot = yield* (yield* DailyNotes.DailyNotes).current;
          assert.equal(snapshot.directory, path.join(baseDir, "notes"));
          assert.deepEqual(
            snapshot.days.map((day) => day.date),
            ["2026-11-23", "2026-11-01", "2025-12-31"],
          );
        }),
      {
        seed: {
          "2026-11-20.md/": "",
          "2026-11-01.md": "- one",
          "2025-12-31.md": "- last year",
          "2026-11-23.md": "- today",
          "2026-11-22.md": "  \n\n",
          "2026-11-21.md": "",
          "2026-11-24.txt": "- wrong extension",
          "notes.md": "- not a day",
          "2026-1-02.md": "- bad date",
        },
      },
    ),
  );

  it.effect("writes, reads back, and deletes the day when content is blank", () =>
    withNotes((baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const notes = yield* DailyNotes.DailyNotes;
        const file = path.join(baseDir, "notes", "2026-11-23.md");

        const missing = yield* notes.read("2026-11-23");
        assert.deepEqual(missing, { date: "2026-11-23", content: "", updatedAt: null });
        assert.isFalse(yield* fs.exists(path.join(baseDir, "notes")));

        const written = yield* notes.write({ date: "2026-11-23", content: "- 早会\n  - 跟进" });
        assert.isNotNull(written.updatedAt);
        assert.equal(yield* fs.readFileString(file), "- 早会\n  - 跟进");
        assert.deepEqual(yield* notes.read("2026-11-23"), written);
        assert.deepEqual(
          (yield* notes.current).days.map((day) => day.date),
          ["2026-11-23"],
        );

        const cleared = yield* notes.write({ date: "2026-11-23", content: " \n" });
        assert.deepEqual(cleared, { date: "2026-11-23", content: "", updatedAt: null });
        assert.isFalse(yield* fs.exists(file));
        assert.deepEqual((yield* notes.current).days, []);
        // Clearing a day that has no file is a no-op, not an error.
        yield* notes.write({ date: "2026-11-22", content: "" });
      }),
    ),
  );

  it.effect("uses the folder from settings, expanding a leading ~", () =>
    withNotes(
      (baseDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const notes = yield* DailyNotes.DailyNotes;
          yield* notes.write({ date: "2026-11-23", content: "- elsewhere" });
          const dir = path.join(baseDir, "Documents", "daily");
          assert.equal((yield* notes.current).directory, dir);
          assert.equal(yield* fs.readFileString(path.join(dir, "2026-11-23.md")), "- elsewhere");
        }),
      { dailyNotesDirectory: "~/Documents/daily" },
    ),
  );
});
