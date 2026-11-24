import { contextBridge, ipcRenderer } from "electron";

import {
  ISLAND_ACTION_CHANNEL,
  ISLAND_POINTER_CHANNEL,
  ISLAND_STATE_CHANNEL,
} from "./ipc/channels.ts";

contextBridge.exposeInMainWorld("t3Island", {
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on(ISLAND_STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ISLAND_STATE_CHANNEL, handler);
  },
  setInteractive: (interactive: boolean) =>
    ipcRenderer.send(ISLAND_POINTER_CHANNEL, interactive === true),
  act: (action: unknown) => ipcRenderer.send(ISLAND_ACTION_CHANNEL, action),
});
