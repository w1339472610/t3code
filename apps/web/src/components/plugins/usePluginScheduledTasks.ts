import { ScheduledTaskId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import {
  pluginScheduledTasksSnapshot,
  type PluginInboundMessage,
  type PluginTimeRange,
} from "./pluginBridge";

/**
 * The `scheduledTasks` feed for a plugin with `scheduledTasks:read`. Nothing is read until the
 * plugin asks for a range with `watchScheduledTasks`.
 */
export function usePluginScheduledTasks(environmentId: EnvironmentId, enabled: boolean) {
  const navigate = useNavigate();
  const [range, setRange] = useState<PluginTimeRange | null>(null);
  const watching = enabled ? range : null;
  const tasks = useEnvironmentQuery(
    watching === null ? null : serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const runs = useEnvironmentQuery(
    watching === null
      ? null
      : serverEnvironment.scheduledTaskRuns({ environmentId, input: watching }),
  );
  const projects = useProjects();
  const providers = useEnvironmentProviders().get(environmentId);
  // The tick is a UTC minute without a zone; spelled out so plugins don't read it as local time.
  const now = `${useNowMinute()}:00.000Z`;

  // A run ends without touching its task, so watch the threads the runs went to.
  const shells = useQuietThreadShells(watching !== null);
  const runThreadIds = new Set((runs.data?.runs ?? []).map((run) => run?.threadId));
  const runActivity = shells
    .filter((shell) => shell.environmentId === environmentId && runThreadIds.has(shell.id))
    .map((shell) => `${shell.id}:${shell.latestRun?.runId}:${shell.latestRun?.status}`)
    .join("|");
  const seenActivity = useRef<string | null>(null);
  const refreshRuns = runs.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads runs from the server when a watched thread's run changes
  useEffect(() => {
    const previous = seenActivity.current;
    seenActivity.current = runActivity;
    if (previous !== null && previous !== runActivity) refreshRuns();
  }, [runActivity, refreshRuns]);

  const agents = new Map(
    deriveProviderInstanceEntries(providers ?? []).map((entry) => [
      entry.instanceId as string,
      { instanceId: entry.instanceId, driver: entry.driverKind, label: entry.displayName },
    ]),
  );
  const json =
    watching === null
      ? null
      : JSON.stringify(
          pluginScheduledTasksSnapshot({
            range: watching,
            now,
            tasks: tasks.data?.tasks.flatMap((task) => (task === undefined ? [] : [task])) ?? null,
            runs: runs.data,
            error: tasks.error ?? runs.error,
            projectName: (projectId) =>
              projects.find(
                (project) => project.environmentId === environmentId && project.id === projectId,
              )?.title ?? null,
            agent: (instanceId) =>
              agents.get(instanceId) ?? { instanceId, driver: instanceId, label: instanceId },
          }),
        );

  /** Handles this feed's messages; false for messages it doesn't own. */
  const handle = (message: PluginInboundMessage): boolean => {
    if (!enabled) return false;
    switch (message.type) {
      case "watchScheduledTasks":
        setRange(message.range);
        return true;
      case "openScheduledTask":
        void navigate({
          to: "/settings/scheduled-tasks",
          search:
            message.taskId === null
              ? {}
              : { environmentId, taskId: ScheduledTaskId.make(message.taskId) },
        });
        return true;
      default:
        return false;
    }
  };

  return { json, handle };
}
