import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { PluginPage } from "../components/plugins/PluginPage";

function PluginPageRoute() {
  const { pluginId, pageId } = Route.useParams();
  const { environmentId } = Route.useSearch();
  return <PluginPage pluginId={pluginId} pageId={pageId} environmentId={environmentId} />;
}

export const Route = createFileRoute("/_chat/plugins/$pluginId/$pageId")({
  validateSearch: (raw: Record<string, unknown>): { environmentId?: EnvironmentId } =>
    typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {},
  component: PluginPageRoute,
});
