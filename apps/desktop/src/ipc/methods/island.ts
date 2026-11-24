import { DesktopIslandSnapshotSchema } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { DesktopIsland } from "../../island/DesktopIsland.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { ISLAND_ACTION_TO_APP_CHANNEL, SET_ISLAND_CHANNEL } from "../channels.ts";

export const installDesktopIsland = Effect.fn("desktop.ipc.installDesktopIsland")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const platform = yield* HostProcess.Platform;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runSync = Effect.runSyncWith(context);

  const island =
    platform === "darwin"
      ? new DesktopIsland({
          preloadPath: environment.path.join(environment.dirname, "island-preload.cjs"),
          createWindow: (options) =>
            runSync(electronWindow.create(options, { auxiliary: true, ownAppearance: true })),
          act: (source, action) => {
            source.send(ISLAND_ACTION_TO_APP_CHANNEL, action);
            // Answers and stops happen in place; only opening something brings the app forward.
            if (action.type !== "open" && action.type !== "settings") return;
            const owner = Electron.BrowserWindow.fromWebContents(source);
            if (owner) runFork(electronWindow.reveal(owner));
          },
        })
      : null;

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_ISLAND_CHANNEL,
      payload: Schema.NullOr(DesktopIslandSnapshotSchema),
      result: Schema.Void,
      handler: (snapshot, event) =>
        Effect.sync(() => {
          if (!island || event === undefined) return;
          const source = Electron.webContents.fromId(event.sender.id);
          if (source) island.update(snapshot, source);
        }),
    }),
  );
  if (island) yield* Effect.addFinalizer(() => Effect.sync(() => island.destroy()));
});
