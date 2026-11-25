import {
  isPluginEnabled,
  resolvePluginConfig,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useGT } from "gt-react";

import type { RightPanelSurface } from "~/rightPanelStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useServerConfigs,
  useThreadRelationshipShells,
} from "~/state/entities";

import { PluginFrame, PluginNotice } from "./PluginFrame";
import { pluginThreadSnapshot } from "./pluginBridge";
import { usePluginScheduledTasks } from "./usePluginScheduledTasks";

type PluginSurface = Extract<RightPanelSurface, { kind: "plugin" }>;

export function PluginPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly surface: PluginSurface;
  readonly workspaceRoot: string | undefined;
}) {
  const gt = useGT();
  const config = useServerConfigs().get(props.environmentId);
  const plugin = config?.plugins?.plugins.find((entry) => entry.id === props.surface.pluginId);
  const panel = plugin?.panels.find((entry) => entry.id === props.surface.panelId);
  if (config === undefined || plugin === undefined || panel === undefined) {
    return <PluginNotice>{gt("This plugin is not installed on this environment.")}</PluginNotice>;
  }
  if (!isPluginEnabled(config.settings.plugins, plugin.id)) {
    return <PluginNotice>{gt("This plugin is turned off in Settings → Plugins.")}</PluginNotice>;
  }
  const permissions = plugin.permissions ?? [];
  return (
    <PluginPanelFrame
      // A new entry or grant set is a different document.
      key={`${plugin.id}:${panel.id}:${panel.entry}:${permissions.join(",")}`}
      environmentId={props.environmentId}
      threadRef={props.threadRef}
      pluginId={plugin.id}
      title={panel.title}
      entry={panel.entry}
      canReadThread={permissions.includes("thread:read")}
      canNavigate={permissions.includes("thread:navigate")}
      canReadScheduledTasks={permissions.includes("scheduledTasks:read")}
      workspaceRoot={props.workspaceRoot}
      pluginConfig={resolvePluginConfig(plugin, config.settings.plugins[plugin.id])}
    />
  );
}

function PluginPanelFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly pluginId: string;
  readonly title: string;
  readonly entry: string;
  readonly canReadThread: boolean;
  readonly canNavigate: boolean;
  readonly canReadScheduledTasks: boolean;
  readonly workspaceRoot: string | undefined;
  readonly pluginConfig: ReturnType<typeof resolvePluginConfig>;
}) {
  const readRef = props.canReadThread ? props.threadRef : null;
  const shell = useQuietThreadShell(readRef);
  const structure = useQuietThreadProjection(readRef);
  const related = useThreadRelationshipShells(props.threadRef);
  const scheduledTasks = usePluginScheduledTasks(props.environmentId, props.canReadScheduledTasks);
  const snapshot = props.canReadThread
    ? JSON.stringify(
        pluginThreadSnapshot({
          shell: shell?.source ?? null,
          structure: structure?.projection ?? null,
          related,
        }),
      )
    : null;
  return (
    <PluginFrame
      environmentId={props.environmentId}
      pluginId={props.pluginId}
      title={props.title}
      entry={props.entry}
      surface="panel"
      threadId={props.threadRef.threadId}
      projectCwd={props.workspaceRoot ?? null}
      config={props.pluginConfig}
      canNavigate={props.canNavigate}
      feeds={[
        ["thread", snapshot],
        ["scheduledTasks", scheduledTasks.json],
      ]}
      onMessage={scheduledTasks.handle}
    />
  );
}
