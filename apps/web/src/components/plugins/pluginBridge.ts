import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  isPluginEnabled,
  type OrchestrationV2ThreadShell,
  type PluginManifest,
  type PluginPageIcon,
  type PluginSettingsEntry,
  type PluginsSnapshot,
  type ScheduledTask,
  type ScheduledTaskListRunsResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Every message on the plugin bridge carries this marker, so stray posts are ignored. */
export const PLUGIN_BRIDGE_VERSION = 1;

export type PluginInboundMessage =
  | { readonly type: "ready" }
  | { readonly type: "openThread"; readonly threadId: string }
  | { readonly type: "watchScheduledTasks"; readonly range: PluginTimeRange }
  | { readonly type: "openScheduledTask"; readonly taskId: string | null };

export interface PluginTimeRange {
  readonly from: string;
  readonly to: string;
}

/** A month view with its leading and trailing weeks fits; a plugin can't ask for years of runs. */
const MAX_WATCH_RANGE_MS = 62 * 24 * 60 * 60_000;

function readTimeRange(from: unknown, to: unknown): PluginTimeRange | null {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start > MAX_WATCH_RANGE_MS) return null;
  // Normalized, so the same range from any offset reuses one query.
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

export function readPluginMessage(data: unknown): PluginInboundMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.t3 !== PLUGIN_BRIDGE_VERSION) return null;
  if (message.type === "ready") return { type: "ready" };
  if (message.type === "openThread" && typeof message.threadId === "string") {
    return { type: "openThread", threadId: message.threadId };
  }
  if (message.type === "watchScheduledTasks") {
    const range = readTimeRange(message.from, message.to);
    return range === null ? null : { type: "watchScheduledTasks", range };
  }
  if (message.type === "openScheduledTask") {
    if (message.taskId !== undefined && typeof message.taskId !== "string") return null;
    return { type: "openScheduledTask", taskId: message.taskId ?? null };
  }
  return null;
}

const PLUGIN_TASK_PROMPT_MAX_CHARS = 500;

export interface PluginTaskAgent {
  readonly instanceId: string;
  readonly driver: string;
  readonly label: string;
}

/** What a `scheduledTasks:read` plugin sees: tasks, and the runs that started in its range. */
export function pluginScheduledTasksSnapshot(input: {
  readonly range: PluginTimeRange;
  readonly now: string;
  readonly tasks: ReadonlyArray<ScheduledTask> | null;
  readonly runs: ScheduledTaskListRunsResult | null;
  readonly error: string | null;
  readonly projectName: (projectId: string) => string | null;
  readonly agent: (instanceId: string) => PluginTaskAgent;
}) {
  return {
    from: input.range.from,
    to: input.range.to,
    now: input.now,
    loading: input.tasks === null || input.runs === null,
    // The server's zone decides when fixed times fire; until it answers, the viewer's is the guess.
    timeZone: input.runs?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    truncated: input.runs?.truncated ?? false,
    error: input.error,
    tasks: (input.tasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt.slice(0, PLUGIN_TASK_PROMPT_MAX_CHARS),
      enabled: task.enabled,
      // Webhook signing details stay with T3; the type is all a calendar needs.
      schedule: task.schedule.type === "webhook" ? { type: "webhook" as const } : task.schedule,
      projectId: task.projectId,
      projectName: input.projectName(task.projectId),
      threadId: task.threadId,
      threadMode: task.threadMode ?? (task.threadId === null ? "new_thread" : "continue"),
      agent: { ...input.agent(task.modelSelection.instanceId), model: task.modelSelection.model },
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      lastRunStatus: task.lastRunStatus,
      lastRunError: task.lastRunError,
      runCount: task.runCount,
      createdAt: task.createdAt,
      blockedByPolicy: task.blockedByPolicy ?? null,
    })),
    runs: (input.runs?.runs ?? []).flatMap((run) =>
      run === undefined
        ? []
        : [
            {
              taskId: run.taskId,
              threadId: run.threadId,
              threadTitle: run.threadTitle,
              runId: run.runId,
              trigger: run.trigger,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              status: run.status,
            },
          ],
    ),
  };
}

const iso = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

function parentThreadId(thread: OrchestrationV2ThreadShell): string | null {
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

function threadSummary(thread: OrchestrationV2ThreadShell) {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    activity: thread.activityRunStatus ?? null,
    runStartedAt: iso(thread.latestRunStartedAt),
    runCompletedAt: iso(thread.latestRunCompletedAt),
    waitingForUser: thread.pendingRuntimeRequest !== null,
    lastError: thread.lastError ?? null,
  };
}

/** What a `thread:read` plugin sees of the open thread; plain JSON so it survives postMessage. */
export function pluginThreadSnapshot(input: {
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly structure: ThreadStructure | null;
  readonly related: ReadonlyArray<OrchestrationV2ThreadShell>;
}) {
  const { shell, structure } = input;
  // Plans carry their steps even when the run's turn items sit in collapsed, unloaded history.
  const todoPlans = (structure?.plans ?? []).filter((plan) => plan.kind === "todo_list");
  const todoPlan =
    todoPlans.findLast((plan) => shell !== null && plan.runId === shell.latestRunId) ??
    todoPlans.at(-1);
  const todos =
    todoPlan?.kind === "todo_list"
      ? {
          planId: todoPlan.id,
          status: todoPlan.status,
          fromLatestRun: shell !== null && todoPlan.runId === shell.latestRunId,
          explanation: todoPlan.explanation ?? null,
          steps: todoPlan.steps.map((step) => ({
            id: step.id,
            text: step.text,
            status: step.status,
            durationMs: step.durationMs ?? null,
            runningSince: step.durationAnchorAt ?? null,
          })),
        }
      : null;
  const ownParent = shell === null ? null : parentThreadId(shell);
  const subagents = structure?.subagents ?? [];
  const subagentThreadIds = new Set(subagents.map((subagent) => subagent.childThreadId));
  return {
    thread:
      shell === null
        ? null
        : {
            ...threadSummary(shell),
            goal: shell.goal
              ? { objective: shell.goal.objective, status: shell.goal.status }
              : null,
          },
    todos,
    subagents: subagents.map((subagent) => ({
      id: subagent.id,
      title: subagent.title ?? subagent.prompt.split("\n", 1)[0]?.slice(0, 120) ?? "",
      status: subagent.status,
      progress: subagent.progress ?? null,
      childThreadId: subagent.childThreadId,
      startedAt: iso(subagent.startedAt),
      completedAt: iso(subagent.completedAt),
    })),
    backgroundTasks: (shell?.pendingBackgroundTasks ?? []).map((task) => ({
      id: task.taskId,
      kind: task.kind,
      description: task.description ?? null,
    })),
    related: input.related
      .filter((thread) => thread.id !== shell?.id && !subagentThreadIds.has(thread.id))
      .map((thread) => ({
        ...threadSummary(thread),
        relation:
          thread.id === ownParent
            ? ("parent" as const)
            : shell !== null && parentThreadId(thread) === shell.id
              ? ("child" as const)
              : ("linked" as const),
      })),
  };
}

/** Built-in launcher letters win; a plugin panel claiming one goes without a shortcut. */
const RESERVED_SURFACE_SHORTCUTS = new Set(["B", "T", "F", "D", "P", "L", "M", "N", "S"]);

export interface PluginPanelLauncher {
  readonly pluginId: string;
  readonly panelId: string;
  readonly title: string;
  readonly shortcut: string | null;
}

export function pluginPanelLaunchers(
  plugins: ReadonlyArray<PluginManifest>,
): ReadonlyArray<PluginPanelLauncher> {
  const taken = new Set(RESERVED_SURFACE_SHORTCUTS);
  return plugins.flatMap((plugin) =>
    plugin.panels.map((panel) => {
      const letter = panel.shortcut?.toUpperCase() ?? null;
      const shortcut = letter !== null && !taken.has(letter) ? letter : null;
      if (shortcut !== null) taken.add(shortcut);
      return { pluginId: plugin.id, panelId: panel.id, title: panel.title, shortcut };
    }),
  );
}

export interface PluginPageLauncher {
  readonly pluginId: string;
  readonly pageId: string;
  readonly title: string;
  readonly icon: PluginPageIcon;
  readonly readsScheduledTasks: boolean;
}

export function pluginPageLaunchers(
  plugins: ReadonlyArray<PluginManifest>,
): ReadonlyArray<PluginPageLauncher> {
  return plugins.flatMap((plugin) =>
    (plugin.pages ?? []).map((page) => ({
      pluginId: plugin.id,
      pageId: page.id,
      title: page.title,
      icon: page.icon ?? "puzzle",
      readsScheduledTasks: plugin.permissions?.includes("scheduledTasks:read") === true,
    })),
  );
}

/** Plugins the user has not turned off in Settings → Plugins. */
export function enabledPlugins(
  config:
    | {
        readonly plugins?: PluginsSnapshot | undefined;
        readonly settings: { readonly plugins: Readonly<Record<string, PluginSettingsEntry>> };
      }
    | undefined,
): ReadonlyArray<PluginManifest> {
  return (config?.plugins?.plugins ?? []).filter((plugin) =>
    isPluginEnabled(config?.settings.plugins, plugin.id),
  );
}
