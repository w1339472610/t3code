import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2ThreadShell, PluginManifest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginPanelLaunchers, pluginThreadSnapshot, readPluginMessage } from "./pluginBridge";

const plugin = (id: string, shortcuts: ReadonlyArray<string | undefined>): PluginManifest => ({
  id,
  name: id,
  version: "1",
  panels: shortcuts.map((shortcut, index) => ({
    id: `p${index}`,
    title: `${id} ${index}`,
    entry: "index.html",
    ...(shortcut === undefined ? {} : { shortcut }),
  })),
});

describe("pluginPanelLaunchers", () => {
  it("drops shortcuts taken by built-in surfaces or an earlier panel", () => {
    const launchers = pluginPanelLaunchers([
      plugin("a", ["g", "T", undefined]),
      plugin("b", ["G"]),
    ]);
    expect(launchers.map((launcher) => launcher.shortcut)).toEqual(["G", null, null, null]);
  });
});

describe("readPluginMessage", () => {
  it("accepts only versioned, well-formed messages", () => {
    expect(readPluginMessage({ t3: 1, type: "ready" })).toEqual({ type: "ready" });
    expect(readPluginMessage({ t3: 1, type: "openThread", threadId: "x" })).toEqual({
      type: "openThread",
      threadId: "x",
    });
    expect(readPluginMessage({ t3: 1, type: "openThread" })).toBeNull();
    expect(
      readPluginMessage({
        t3: 1,
        type: "watchScheduledTasks",
        from: "2026-11-09T00:00:00+08:00",
        to: "2026-11-16T00:00:00+08:00",
      }),
    ).toEqual({
      type: "watchScheduledTasks",
      range: { from: "2026-11-08T16:00:00.000Z", to: "2026-11-15T16:00:00.000Z" },
    });
    // Backwards, unparseable, or longer than a month view's weeks.
    for (const [from, to] of [
      ["2026-11-16T00:00:00Z", "2026-11-09T00:00:00Z"],
      ["soon", "2026-11-09T00:00:00Z"],
      ["2026-01-01T00:00:00Z", "2026-11-09T00:00:00Z"],
    ]) {
      expect(readPluginMessage({ t3: 1, type: "watchScheduledTasks", from, to })).toBeNull();
    }
    expect(readPluginMessage({ t3: 1, type: "openScheduledTask" })).toEqual({
      type: "openScheduledTask",
      taskId: null,
    });
    expect(readPluginMessage({ t3: 1, type: "openScheduledTask", taskId: 3 })).toBeNull();
    expect(readPluginMessage({ type: "ready" })).toBeNull();
    expect(readPluginMessage("ready")).toBeNull();
  });
});

describe("pluginThreadSnapshot", () => {
  it("prefers the latest run's todo list over a newer-looking earlier one", () => {
    const todo = (id: string, runId: string) => ({
      id,
      kind: "todo_list" as const,
      runId,
      status: "active" as const,
      steps: [{ id: "s", text: id, status: "completed" as const }],
    });
    const snapshot = pluginThreadSnapshot({
      shell: {
        id: "t",
        title: "T",
        status: "running",
        latestRunId: "run-2",
        lineage: { parentThreadId: null },
        forkedFrom: null,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
      } as unknown as OrchestrationV2ThreadShell,
      structure: {
        plans: [todo("current", "run-2"), todo("older", "run-1")],
        subagents: [],
      } as unknown as ThreadStructure,
      related: [],
    });
    expect(snapshot.todos?.steps[0]?.text).toBe("current");
    expect(snapshot.todos?.fromLatestRun).toBe(true);
  });
});
