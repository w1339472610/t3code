// @effect-diagnostics globalTimers:off - A plain Electron controller, outside an Effect runtime.
import {
  type DesktopIslandAction,
  DesktopIslandActionSchema,
  type DesktopIslandSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import {
  ISLAND_ACTION_CHANNEL,
  ISLAND_POINTER_CHANNEL,
  ISLAND_STATE_CHANNEL,
} from "../ipc/channels.ts";
import { buildIslandPageDataUrl } from "./islandPage.ts";

/** Room for the open panel and its shadow. The window never resizes; the page morphs inside it. */
const ISLAND_WINDOW_WIDTH = 480;
const ISLAND_WINDOW_HEIGHT = 640;
/** Long enough for the page's exit animation to finish before the window goes away. */
const HIDE_AFTER_EXIT_MS = 700;

// A 14-inch MacBook Pro at its default scale. Every notched MacBook keeps the camera
// housing proportional to the panel, so scaling this covers the 13, 14, 15 and 16 inch models.
const NOTCH_REFERENCE = { displayWidth: 1512, displayHeight: 982, width: 185, height: 32 };
const NOTCH_ASPECT_TOLERANCE = 0.012;

const decodeAction = Schema.decodeUnknownOption(DesktopIslandActionSchema);

/** Threads to show, or the user keeps a resting island in the menu bar. */
const wantsWindow = (snapshot: DesktopIslandSnapshot) =>
  snapshot.items.length > 0 || snapshot.prefs.idleVisible;

export interface IslandGeometry {
  readonly notch: { readonly width: number; readonly height: number } | null;
  readonly menuBarHeight: number;
}

function islandGeometry(
  display: Pick<Electron.Display, "bounds" | "workArea" | "internal">,
): IslandGeometry {
  const menuBarHeight = Math.max(0, display.workArea.y - display.bounds.y);
  const { width, height } = display.bounds;
  const referenceAspect = NOTCH_REFERENCE.displayWidth / NOTCH_REFERENCE.displayHeight;
  const notched =
    display.internal &&
    height > 0 &&
    Math.abs(width / height - referenceAspect) <= NOTCH_ASPECT_TOLERANCE;
  if (!notched) return { notch: null, menuBarHeight: menuBarHeight || 24 };
  const scale = width / NOTCH_REFERENCE.displayWidth;
  return {
    notch: {
      width: Math.round(NOTCH_REFERENCE.width * scale),
      height: Math.max(menuBarHeight, Math.round(NOTCH_REFERENCE.height * scale)),
    },
    menuBarHeight,
  };
}

export interface DesktopIslandOptions {
  readonly preloadPath: string;
  readonly createWindow: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => Electron.BrowserWindow;
  /** The island asked for something; `source` is the renderer whose snapshot it showed. */
  readonly act: (source: Electron.WebContents, action: DesktopIslandAction) => void;
}

/**
 * A transparent, never-focused panel over the middle of the menu bar. The main window's
 * renderer owns the data and pushes snapshots; the panel only draws them. It lets the pointer
 * through until the page reports that it is over the island.
 */
export class DesktopIsland {
  private readonly options: DesktopIslandOptions;
  private window: Electron.BrowserWindow | undefined;
  /** `isLoading()` can still read true inside did-finish-load, so track the load here. */
  private loaded = false;
  private source: Electron.WebContents | undefined;
  private snapshot: DesktopIslandSnapshot | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private screenListening = false;
  /** Whether the window was last set to show over full-screen apps. */
  private onFullScreen: boolean | undefined;

  constructor(options: DesktopIslandOptions) {
    this.options = options;
    Electron.ipcMain.on(ISLAND_POINTER_CHANNEL, this.onPointer);
    Electron.ipcMain.on(ISLAND_ACTION_CHANNEL, this.onAction);
  }

  update(snapshot: DesktopIslandSnapshot | null, source: Electron.WebContents): void {
    if (this.source !== source) {
      this.source?.removeListener("destroyed", this.onSourceDestroyed);
      this.source = source;
      source.once("destroyed", this.onSourceDestroyed);
    }
    this.snapshot = snapshot;
    if (snapshot === null) {
      this.closeWindow();
      return;
    }
    if (!wantsWindow(snapshot)) {
      if (!this.window) return;
      this.send();
      this.scheduleHide();
      return;
    }
    this.cancelHide();
    const window = this.ensureWindow();
    this.applyFullScreen(window, snapshot.prefs.onFullScreen);
    this.send();
    if (this.loaded && !window.isVisible()) window.showInactive();
  }

  destroy(): void {
    Electron.ipcMain.removeListener(ISLAND_POINTER_CHANNEL, this.onPointer);
    Electron.ipcMain.removeListener(ISLAND_ACTION_CHANNEL, this.onAction);
    this.source?.removeListener("destroyed", this.onSourceDestroyed);
    this.source = undefined;
    this.stopScreenListening();
    this.closeWindow();
  }

  private ensureWindow(): Electron.BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = this.options.createWindow({
      ...this.bounds(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      // The panel never becomes key, so every click is a first click; let it through.
      acceptFirstMouse: true,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      enableLargerThanScreen: true,
      type: "panel",
      title: "T3 Code Island",
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window = window;
    this.loaded = false;
    // The status level sits above the menu bar, which normal and floating windows cannot cover.
    window.setAlwaysOnTop(true, "status");
    this.onFullScreen = undefined;
    this.applyFullScreen(window, this.snapshot?.prefs.onFullScreen ?? true);
    window.excludedFromShownWindowsMenu = true;
    window.setWindowButtonVisibility(false);
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("did-finish-load", () => {
      if (this.window !== window) return;
      this.loaded = true;
      this.send();
      if (this.snapshot && wantsWindow(this.snapshot)) window.showInactive();
    });
    window.once("closed", () => {
      if (this.window === window) this.window = undefined;
    });
    this.startScreenListening();
    void window.loadURL(buildIslandPageDataUrl()).catch(() => undefined);
    return window;
  }

  private applyFullScreen(window: Electron.BrowserWindow, onFullScreen: boolean): void {
    if (this.onFullScreen === onFullScreen) return;
    this.onFullScreen = onFullScreen;
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: onFullScreen,
      skipTransformProcessType: true,
    });
  }

  private bounds(): Electron.Rectangle {
    const display = Electron.screen.getPrimaryDisplay();
    return {
      x: Math.round(display.bounds.x + (display.bounds.width - ISLAND_WINDOW_WIDTH) / 2),
      y: display.bounds.y,
      width: ISLAND_WINDOW_WIDTH,
      height: ISLAND_WINDOW_HEIGHT,
    };
  }

  private send(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !this.loaded) return;
    window.webContents.send(ISLAND_STATE_CHANNEL, {
      snapshot: this.snapshot,
      geometry: islandGeometry(Electron.screen.getPrimaryDisplay()),
    });
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      const window = this.window;
      if (!window || window.isDestroyed()) return;
      if (this.snapshot && wantsWindow(this.snapshot)) return;
      window.setIgnoreMouseEvents(true, { forward: true });
      window.hide();
    }, HIDE_AFTER_EXIT_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer === undefined) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private closeWindow(): void {
    this.cancelHide();
    const window = this.window;
    this.window = undefined;
    this.stopScreenListening();
    if (window && !window.isDestroyed()) window.destroy();
  }

  private readonly place = () => {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.setBounds(this.bounds(), false);
    this.send();
  };

  private startScreenListening(): void {
    if (this.screenListening) return;
    this.screenListening = true;
    Electron.screen.on("display-metrics-changed", this.place);
    Electron.screen.on("display-added", this.place);
    Electron.screen.on("display-removed", this.place);
  }

  private stopScreenListening(): void {
    if (!this.screenListening) return;
    this.screenListening = false;
    Electron.screen.removeListener("display-metrics-changed", this.place);
    Electron.screen.removeListener("display-added", this.place);
    Electron.screen.removeListener("display-removed", this.place);
  }

  private isFromIsland(event: Electron.IpcMainEvent): boolean {
    const window = this.window;
    return (
      window !== undefined &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  }

  private readonly onPointer = (event: Electron.IpcMainEvent, interactive: unknown) => {
    if (!this.isFromIsland(event)) return;
    this.window?.setIgnoreMouseEvents(interactive !== true, { forward: true });
  };

  private readonly onAction = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (!this.isFromIsland(event) || !this.source || this.source.isDestroyed()) return;
    const action = decodeAction(raw);
    if (Option.isSome(action)) this.options.act(this.source, action.value);
  };

  private readonly onSourceDestroyed = () => {
    this.source = undefined;
    this.snapshot = null;
    this.closeWindow();
  };
}
