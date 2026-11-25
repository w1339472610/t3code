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

  it.effect("merges a write with changes made since its base", () =>
    withNotes(
      () =>
        Effect.gen(function* () {
          const notes = yield* DailyNotes.DailyNotes;
          yield* notes.edit({ date: "2026-11-23", append: "- [ ] from agent" });
          const merged = yield* notes.write({
            date: "2026-11-23",
            base: "- a\n- b\n",
            content: "- a typed\n- b\n",
          });
          assert.equal(merged.content, "- a typed\n- b\n- [ ] from agent\n");
          assert.equal((yield* notes.read("2026-11-23")).content, merged.content);
        }),
      { seed: { "2026-11-23.md": "- a\n- b\n" } },
    ),
  );

  it.effect("edits a day by exact replacement, append, or a versioned rewrite", () =>
    withNotes(
      () =>
        Effect.gen(function* () {
          const notes = yield* DailyNotes.DailyNotes;
          const date = "2026-11-23";
          const replaced = yield* notes.edit({
            date,
            edits: [{ oldText: "- [ ] 写周报", newText: "- [x] 写周报" }],
            append: "- 新条目",
          });
          assert.equal(replaced.content, "- [x] 写周报\n- 评审\n- 评审\n- 新条目\n");
          assert.equal(replaced.version, DailyNotes.noteVersion(replaced.content));

          const failure = (input: Parameters<typeof notes.edit>[0]) =>
            Effect.map(Effect.flip(notes.edit(input)), (error) => error.message);
          assert.include(
            yield* failure({ date, edits: [{ oldText: "- 不存在", newText: "" }] }),
            "Not found",
          );
          assert.include(
            yield* failure({ date, edits: [{ oldText: "- 评审", newText: "- 复盘" }] }),
            "appears 2 times",
          );
          assert.include(yield* failure({ date, content: "- 全部重写\n" }), "changed since");
          // A failed edit changes nothing.
          assert.equal((yield* notes.read(date)).content, replaced.content);

          const rewritten = yield* notes.edit({
            date,
            content: "- 全部重写\n",
            version: replaced.version,
          });
          assert.equal((yield* notes.read(date)).content, rewritten.content);
          // A new day needs no version.
          yield* notes.edit({ date: "2026-11-24", content: "- 明天\n" });
        }),
      { seed: { "2026-11-23.md": "- [ ] 写周报\n- 评审\n- 评审\n" } },
    ),
  );

  it.effect("browses dated days within a range and searches every day", () =>
    withNotes(
      () =>
        Effect.gen(function* () {
          const notes = yield* DailyNotes.DailyNotes;
          const range = yield* notes.browse({ from: "2026-11-01", to: "2026-11-22" });
          assert.deepEqual(
            range.days.map((day) => [day.date, day.content]),
            [
              ["2026-11-22", "- 发布\n"],
              ["2026-11-02", "- 周会\n  - 发布计划\n"],
            ],
          );
          assert.deepEqual(range.moreDates, []);
          const found = yield* notes.browse({ query: "发布" });
          assert.deepEqual(found.matches, [
            { date: "2026-11-22", line: 1, text: "- 发布" },
            { date: "2026-11-02", line: 2, text: "  - 发布计划" },
          ]);
        }),
      {
        seed: {
          "2026-11-23.md": "- 今天\n",
          "2026-11-22.md": "- 发布\n",
          "2026-11-02.md": "- 周会\n  - 发布计划\n",
          "2026-10-31.md": "- 上月\n",
        },
      },
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
