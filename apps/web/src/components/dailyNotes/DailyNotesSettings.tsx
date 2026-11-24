import { resolvePastedPath } from "@t3tools/shared/path";
import { useGT } from "gt-react";
import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { useSearchableSetting } from "../settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";

export function DailyNotesSettings() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { scope, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["dailyNotesDirectory"]);
  const edited = useRef(false);
  const draft = useRef("");
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  return (
    <SettingsSection id="daily-notes" title={gt("Daily notes")}>
      <SettingsRow
        {...setting("daily-notes-location")}
        description={gt(
          "Folder for daily notes, one Markdown file per day, such as ~/Notes/Daily. Existing notes are not moved. Leave empty to use the notes folder in the T3 home folder.",
        )}
        serverScoped
        settingKeys={["dailyNotesDirectory"]}
        resetAction={
          mixed || settings.dailyNotesDirectory !== "" ? (
            <SettingResetButton
              ariaLabel={gt("Reset daily notes folder to default")}
              onClick={() => updateSettings({ dailyNotesDirectory: "" })}
            />
          ) : null
        }
        control={
          <Input
            key={`${scopeKey}:${mixed}:${settings.dailyNotesDirectory}`}
            aria-label={gt("Daily notes folder")}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={mixed ? gt("Mixed") : gt("Default")}
            defaultValue={mixed ? "" : settings.dailyNotesDirectory}
            onFocus={(event) => {
              draft.current = event.target.value;
            }}
            onChange={(event) => {
              edited.current = true;
              draft.current = resolvePastedPath(draft.current, event.target.value);
              event.target.value = draft.current;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (edited.current && (mixed || value !== settings.dailyNotesDirectory))
                updateSettings({ dailyNotesDirectory: value });
              edited.current = false;
            }}
          />
        }
      />
    </SettingsSection>
  );
}
