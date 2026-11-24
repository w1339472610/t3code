import type {
  DesktopIslandDoneMinutes,
  DesktopIslandExpandOn,
  DesktopIslandScope,
} from "@t3tools/contracts/settings";

import { msg, useGT, useMessages } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SCOPE_LABELS: Record<DesktopIslandScope, string> = {
  all: msg("All active threads"),
  attention: msg("Only what needs me"),
};
const DONE_LABELS: Record<DesktopIslandDoneMinutes, string> = {
  5: msg("5 minutes"),
  15: msg("15 minutes"),
  60: msg("1 hour"),
};
const EXPAND_LABELS: Record<DesktopIslandExpandOn, string> = {
  hover: msg("On hover"),
  click: msg("On click"),
};

/** The macOS menu bar island and how it behaves. */
export function DesktopIslandSettings() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const off = !settings.desktopIslandEnabled;

  return (
    <SettingsSection id="menu-bar-island-section" title={gt("Menu bar island")}>
      <SettingsRow
        {...setting("menu-bar-island")}
        description={gt(
          "Show threads that are working, waiting on you, or just finished in a small island at the top of the screen.",
        )}
        control={
          <Switch
            checked={settings.desktopIslandEnabled}
            onCheckedChange={(checked) => updateSettings({ desktopIslandEnabled: checked })}
            aria-label={gt("Menu bar island")}
          />
        }
      />
      <SettingsRow
        {...setting("menu-bar-island-idle")}
        description={gt(
          "When nothing is going on, keep the island in the menu bar showing the last thread that finished.",
        )}
        control={
          <Switch
            disabled={off}
            checked={settings.desktopIslandIdleVisible}
            onCheckedChange={(checked) => updateSettings({ desktopIslandIdleVisible: checked })}
            aria-label={gt("Always show the island")}
          />
        }
      />
      <SettingsRow
        {...setting("menu-bar-island-scope")}
        description={gt(
          "Only what needs me keeps approvals, questions, and failures, and leaves out work in progress and finished threads.",
        )}
        control={
          <Select
            disabled={off}
            value={settings.desktopIslandScope}
            onValueChange={(value) => {
              if (value === "all" || value === "attention") {
                updateSettings({ desktopIslandScope: value });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label={gt("Threads on the island")}
            >
              <SelectValue>{m(SCOPE_LABELS[settings.desktopIslandScope])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="all">
                {m(SCOPE_LABELS.all)}
              </SelectItem>
              <SelectItem hideIndicator value="attention">
                {m(SCOPE_LABELS.attention)}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...setting("menu-bar-island-done")}
        description={gt(
          "How long a finished thread stays on the island. Opening it removes it right away.",
        )}
        control={
          <Select
            disabled={off || settings.desktopIslandScope === "attention"}
            value={String(settings.desktopIslandDoneMinutes)}
            onValueChange={(value) => {
              const minutes = Number(value);
              if (minutes === 5 || minutes === 15 || minutes === 60) {
                updateSettings({ desktopIslandDoneMinutes: minutes });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label={gt("Keep finished threads")}
            >
              <SelectValue>{m(DONE_LABELS[settings.desktopIslandDoneMinutes])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {([5, 15, 60] as const).map((minutes) => (
                <SelectItem key={minutes} hideIndicator value={String(minutes)}>
                  {m(DONE_LABELS[minutes])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...setting("menu-bar-island-expand")}
        description={gt(
          "On click keeps the island closed while the pointer passes over the menu bar.",
        )}
        control={
          <Select
            disabled={off}
            value={settings.desktopIslandExpandOn}
            onValueChange={(value) => {
              if (value === "hover" || value === "click") {
                updateSettings({ desktopIslandExpandOn: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-48" aria-label={gt("Open the island")}>
              <SelectValue>{m(EXPAND_LABELS[settings.desktopIslandExpandOn])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="hover">
                {m(EXPAND_LABELS.hover)}
              </SelectItem>
              <SelectItem hideIndicator value="click">
                {m(EXPAND_LABELS.click)}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...setting("menu-bar-island-fullscreen")}
        description={gt(
          "Turn off to keep the island away from videos, slides, and other full-screen apps.",
        )}
        control={
          <Switch
            disabled={off}
            checked={settings.desktopIslandOnFullScreen}
            onCheckedChange={(checked) => updateSettings({ desktopIslandOnFullScreen: checked })}
            aria-label={gt("Show over full-screen apps")}
          />
        }
      />
      <SettingsRow
        {...setting("menu-bar-island-motion")}
        description={gt("Give the island a small bounce when a thread finishes or needs you.")}
        control={
          <Switch
            disabled={off}
            checked={settings.desktopIslandMotion}
            onCheckedChange={(checked) => updateSettings({ desktopIslandMotion: checked })}
            aria-label={gt("Bounce on news")}
          />
        }
      />
    </SettingsSection>
  );
}
