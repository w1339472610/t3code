import type { PluginPageIcon } from "@t3tools/contracts";
import {
  BookOpenIcon,
  CalendarClockIcon,
  CalendarIcon,
  ChartNoAxesColumnIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  PuzzleIcon,
  type LucideIcon,
} from "lucide-react";

import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { enabledPlugins, pluginPageLaunchers } from "./pluginBridge";

const PAGE_ICONS: Record<PluginPageIcon, LucideIcon> = {
  puzzle: PuzzleIcon,
  calendar: CalendarIcon,
  "calendar-clock": CalendarClockIcon,
  "list-checks": ListChecksIcon,
  "layout-dashboard": LayoutDashboardIcon,
  chart: ChartNoAxesColumnIcon,
  book: BookOpenIcon,
};

export function PluginPageIconGlyph(props: {
  readonly icon: PluginPageIcon;
  readonly className?: string;
}) {
  const Icon = PAGE_ICONS[props.icon];
  return <Icon className={props.className} />;
}

/** Pages of the primary environment's enabled plugins, which the sidebar nav and Settings link to. */
export function usePrimaryPluginPages() {
  const environmentId = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  return pluginPageLaunchers(
    enabledPlugins(environmentId === null ? undefined : configs.get(environmentId)),
  );
}
