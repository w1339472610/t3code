import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Plugins from "./Plugins.ts";

const manifest = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    name: id,
    version: "0.1.0",
    panels: [{ id: "main", title: "Main", entry: "index.html" }],
    ...extra,
  });

const withPlugins = <A, E>(
  seeds: Readonly<Record<string, string>>,
  body: Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugins-" });
    for (const [folder, contents] of Object.entries(seeds)) {
      const dir = path.join(baseDir, "plugins", folder);
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "plugin.json"), contents);
    }
    return yield* body.pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("plugins", (it) => {
  it.effect("loads valid plugins and reports why other folders did not load", () =>
    withPlugins(
      {
        progress: manifest("progress", { permissions: ["thread:read"] }),
        notes: manifest("notes"),
        broken: "{ not json",
        mismatch: manifest("other"),
        "Bad Name": manifest("bad-name"),
        "bad-entry": manifest("bad-entry", {
          panels: [{ id: "main", title: "Main", entry: "app.js" }],
        }),
      },
      Effect.gen(function* () {
        const { plugins, issues } = yield* Plugins.scanPlugins(yield* Plugins.pluginsDir());
        assert.deepEqual(
          plugins.map((plugin) => [plugin.id, plugin.permissions ?? null]),
          [
            ["notes", null],
            ["progress", ["thread:read"]],
          ],
        );
        assert.deepEqual(
          issues.map((issue) => issue.folder),
          ["Bad Name", "bad-entry", "broken", "mismatch"],
        );
        assert.include(issues[1]?.message, "entry");
        assert.include(issues[3]?.message, '"other"');
      }),
    ),
  );

  it.effect("resolves a root only for an installed plugin", () =>
    withPlugins(
      { progress: manifest("progress"), mismatch: manifest("other") },
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* Plugins.resolvePluginRoot("progress");
        assert.equal(root, path.join(yield* Plugins.pluginsDir(), "progress"));
        assert.isNull(yield* Plugins.resolvePluginRoot("mismatch"));
        assert.isNull(yield* Plugins.resolvePluginRoot("../progress"));
      }),
    ),
  );
});
