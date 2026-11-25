import { isPluginEnabled, resolvePluginConfig, type EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { PluginFrame, PluginNotice } from "./PluginFrame";
import { PluginPageIconGlyph } from "./pluginPages";
import { usePluginScheduledTasks } from "./usePluginScheduledTasks";

/** A plugin's page in the main area, opened from the sidebar or command palette. */
export function PluginPage(props: {
  readonly pluginId: string;
  readonly pageId: string;
  readonly environmentId: EnvironmentId | undefined;
}) {
  const gt = useGT();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryEnvironmentId;
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const plugin = config?.plugins?.plugins.find((entry) => entry.id === props.pluginId);
  const page = plugin?.pages?.find((entry) => entry.id === props.pageId);
  const permissions = plugin?.permissions ?? [];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader
          electron={isElectron}
          className="border-b border-border [&_svg]:size-4 [&_svg]:text-muted-foreground"
        >
          {page ? <PluginPageIconGlyph icon={page.icon ?? "puzzle"} /> : null}
          <h1 className="min-w-0 truncate font-medium text-sm">{page?.title ?? gt("Plugin")}</h1>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1">
          {environmentId === null || config === undefined || plugin === undefined || !page ? (
            <PluginNotice>
              {gt("This plugin page is not installed on this environment.")}
            </PluginNotice>
          ) : !isPluginEnabled(config.settings.plugins, plugin.id) ? (
            <PluginNotice>{gt("This plugin is turned off in Settings → Plugins.")}</PluginNotice>
          ) : (
            <PluginPageFrame
              key={`${plugin.id}:${page.id}:${page.entry}:${permissions.join(",")}`}
              environmentId={environmentId}
              pluginId={plugin.id}
              title={page.title}
              entry={page.entry}
              canNavigate={permissions.includes("thread:navigate")}
              canReadScheduledTasks={permissions.includes("scheduledTasks:read")}
              pluginConfig={resolvePluginConfig(plugin, config.settings.plugins[plugin.id])}
            />
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function PluginPageFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly title: string;
  readonly entry: string;
  readonly canNavigate: boolean;
  readonly canReadScheduledTasks: boolean;
  readonly pluginConfig: ReturnType<typeof resolvePluginConfig>;
}) {
  const scheduledTasks = usePluginScheduledTasks(props.environmentId, props.canReadScheduledTasks);
  return (
    <PluginFrame
      environmentId={props.environmentId}
      pluginId={props.pluginId}
      title={props.title}
      entry={props.entry}
      surface="page"
      threadId={null}
      projectCwd={null}
      config={props.pluginConfig}
      canNavigate={props.canNavigate}
      feeds={[["scheduledTasks", scheduledTasks.json]]}
      onMessage={scheduledTasks.handle}
    />
  );
}
