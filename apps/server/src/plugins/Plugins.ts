import { PluginId, PluginManifest, type PluginsSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { readThemeFileGuarded } from "../environmentTheme.ts";

const decodeManifestJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(PluginManifest));
const isPluginId = Schema.is(PluginId);

const MANIFEST_FILE = "plugin.json";
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_PLUGINS = 64;

export const pluginsDir = Effect.fn("Plugins.pluginsDir")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "plugins");
});

/** Each plugin is `<root>/<id>/plugin.json`; a folder that fails to load becomes an issue. */
export const scanPlugins = Effect.fn("Plugins.scanPlugins")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): Array<string> => []));

  const plugins: Array<PluginManifest> = [];
  const issues: Array<PluginsSnapshot["issues"][number]> = [];
  for (const entry of entries.toSorted()) {
    if (entry.startsWith(".")) continue;
    const folder = path.join(root, entry);
    const info = yield* fs.stat(folder).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "Directory") continue;
    if (!isPluginId(entry)) {
      issues.push({
        folder: entry,
        message: "Folder name must use lowercase letters, digits and dashes.",
      });
      continue;
    }
    if (plugins.length >= MAX_PLUGINS) {
      issues.push({ folder: entry, message: `Only the first ${MAX_PLUGINS} plugins load.` });
      continue;
    }
    const raw = readThemeFileGuarded(path.join(folder, MANIFEST_FILE), MAX_MANIFEST_BYTES);
    if (raw === null) {
      issues.push({ folder: entry, message: "plugin.json is missing or unreadable." });
      continue;
    }
    const decoded = decodeManifestJsonExit(raw);
    if (decoded._tag === "Failure") {
      const error = Cause.squash(decoded.cause);
      issues.push({
        folder: entry,
        message: `plugin.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (decoded.value.id !== entry) {
      issues.push({
        folder: entry,
        message: `plugin.json says id "${decoded.value.id}", which must match the folder name.`,
      });
      continue;
    }
    plugins.push(decoded.value);
  }
  return { directory: root, plugins, issues } satisfies PluginsSnapshot;
});

/** The folder of an installed plugin, or null when no valid plugin has that id. */
export const resolvePluginRoot = Effect.fn("Plugins.resolvePluginRoot")(function* (
  pluginId: string,
) {
  if (!isPluginId(pluginId)) return null;
  const path = yield* Path.Path;
  const root = yield* pluginsDir();
  const { plugins } = yield* scanPlugins(root);
  return plugins.some((plugin) => plugin.id === pluginId) ? path.join(root, pluginId) : null;
});

interface PublishedPlugins {
  readonly seq: number;
  readonly snapshot: PluginsSnapshot;
}

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly current: Effect.Effect<PluginsSnapshot>;
    /** Emits the current set, then every change to the plugins folder. */
    readonly streamChanges: Stream.Stream<PluginsSnapshot>;
  }
>()("t3/plugins/Plugins/PluginRegistry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* pluginsDir();
  const changes = yield* PubSub.sliding<PublishedPlugins>(1);
  const published = yield* Ref.make<PublishedPlugins>({
    seq: 0,
    snapshot: { directory: root, plugins: [], issues: [] },
  });
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* scanPlugins(root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PublishedPlugins], PublishedPlugins] => {
          if (Equal.equals(previous.snapshot, snapshot)) return [[false, previous], previous];
          const updated = { seq: previous.seq + 1, snapshot };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.ignoreCause({ log: true }));
  // Recursive, so edits to a plugin's own plugin.json are seen too; saves fire in bursts.
  const watchEvents = fs
    .watch(root, { recursive: true })
    .pipe(Stream.debounce(Duration.millis(150)));

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

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
  } satisfies PluginRegistry["Service"];
});

export const layer = Layer.effect(PluginRegistry, make);
