import {
  AuthSettingsWriteScope,
  isPluginEnabled,
  resolvePluginSettingValue,
  type EnvironmentId,
  type PluginConfigValue,
  type PluginManifest,
  type PluginPermission,
  type PluginSetting,
  type PluginSettingsEntry,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { FolderOpenIcon, PuzzleIcon } from "lucide-react";
import { useRef } from "react";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const PERMISSION_LABELS: Record<PluginPermission, string> = {
  "thread:read": msg("Read the open thread"),
  "thread:navigate": msg("Open other threads"),
  "scheduledTasks:read": msg("Read scheduled tasks and their runs"),
};

export function PluginsSettingsPanel() {
  const { connectedEnvironments } = useSettingsScope();
  const gt = useGT();
  return (
    <SettingsPageContainer>
      {connectedEnvironments.length === 0 ? (
        <SettingsSection id="plugins" title={gt("Plugins")}>
          <SettingsRow
            title={gt("No connected environment")}
            description={gt("Plugins live on an environment. Connect one to manage its plugins.")}
          />
        </SettingsSection>
      ) : (
        connectedEnvironments.map((environment) => (
          <EnvironmentPlugins
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={connectedEnvironments.length > 1 ? environment.label : null}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentPlugins(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const gt = useGT();
  const config = useServerConfigs().get(props.environmentId);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const snapshot = config?.plugins;
  const entries = config?.settings.plugins ?? {};
  const sectionTitle =
    props.label === null ? gt("Plugins") : gt("Plugins · {label}", { label: props.label });

  const saveEntry = (pluginId: string, entry: PluginSettingsEntry | null) => {
    void persist({
      environmentId: props.environmentId,
      input: { patch: { plugins: { [pluginId]: entry } } },
    }).then((result) => {
      if (result._tag !== "Failure") return;
      toastManager.add({ type: "error", title: gt("Plugin setting not saved") });
    });
  };

  if (snapshot === undefined) {
    return (
      <SettingsSection id="plugins" title={sectionTitle}>
        <SettingsRow
          title={gt("Plugins are not available")}
          description={gt("This environment runs a T3 Code server without plugin support.")}
        />
      </SettingsSection>
    );
  }

  const canOpenFolder = config?.availableEditors.includes("file-manager") === true;
  return (
    <>
      <SettingsSection
        id="plugins"
        title={sectionTitle}
        headerAction={
          canOpenFolder ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void openInEditor({
                  environmentId: props.environmentId,
                  input: { cwd: snapshot.directory, editor: "file-manager" },
                }).then((result) => {
                  if (result._tag === "Failure") {
                    toastManager.add({
                      type: "error",
                      title: gt("Could not open the plugins folder"),
                    });
                  }
                });
              }}
            >
              <FolderOpenIcon />
              <T>Open folder</T>
            </Button>
          ) : null
        }
      >
        <SettingsRow
          title={gt("Plugin folder")}
          description={
            <>
              <T>Each plugin is a folder with a plugin.json. Changes here show up right away.</T>
              <code className="mt-1 block break-all font-mono text-xs">{snapshot.directory}</code>
            </>
          }
        />
        {snapshot.plugins.length === 0 && snapshot.issues.length === 0 ? (
          <SettingsRow
            title={gt("No plugins installed")}
            description={gt("Put a plugin folder in the plugin folder above.")}
          />
        ) : null}
      </SettingsSection>

      {snapshot.plugins.map((plugin) => (
        <PluginSection
          key={plugin.id}
          plugin={plugin}
          entry={entries[plugin.id]}
          enabled={isPluginEnabled(entries, plugin.id)}
          canWrite={canWrite}
          onSave={(entry) => saveEntry(plugin.id, entry)}
        />
      ))}

      {snapshot.issues.length > 0 ? (
        <SettingsSection id="plugin-issues" title={gt("Could not load")}>
          {snapshot.issues.map((issue) => (
            <SettingsRow
              key={issue.folder}
              title={<span className="font-mono">{issue.folder}</span>}
              description={issue.message}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function PluginSection(props: {
  readonly plugin: PluginManifest;
  readonly entry: PluginSettingsEntry | undefined;
  readonly enabled: boolean;
  readonly canWrite: boolean;
  readonly onSave: (entry: PluginSettingsEntry | null) => void;
}) {
  const gt = useGT();
  const { plugin, entry, enabled } = props;
  const storedConfig = entry?.config;
  const hasStoredConfig = storedConfig !== undefined && Object.keys(storedConfig).length > 0;

  const save = (next: PluginSettingsEntry) => {
    const config = next.config && Object.keys(next.config).length > 0 ? next.config : undefined;
    props.onSave(
      next.enabled === false || config !== undefined
        ? { ...(next.enabled === false ? { enabled: false } : {}), ...(config ? { config } : {}) }
        : null,
    );
  };
  const setValue = (key: string, value: PluginConfigValue) =>
    save({ ...entry, config: { ...storedConfig, [key]: value } });

  return (
    <SettingsSection
      id={`plugin-${plugin.id}`}
      title={plugin.name}
      icon={<PuzzleIcon className="size-4 text-muted-foreground" />}
      titleAction={
        <Badge variant="outline" size="sm" className="ms-1">
          {plugin.version}
        </Badge>
      }
      headerAction={
        <Switch
          checked={enabled}
          disabled={!props.canWrite}
          aria-label={gt("Enable {name}", { name: plugin.name })}
          onCheckedChange={(checked) => save({ ...entry, enabled: Boolean(checked) })}
        />
      }
    >
      <SettingsRow
        title={enabled ? gt("Enabled") : gt("Turned off")}
        description={
          <span className="flex flex-col gap-2">
            {plugin.description ? <span>{plugin.description}</span> : null}
            <PluginFacts plugin={plugin} />
          </span>
        }
      />
      {enabled
        ? (plugin.settings ?? []).map((setting) => (
            <PluginSettingRow
              key={setting.key}
              setting={setting}
              stored={storedConfig?.[setting.key]}
              disabled={!props.canWrite}
              onChange={(value) => setValue(setting.key, value)}
            />
          ))
        : null}
      {enabled && hasStoredConfig ? (
        <SettingsRow
          title={gt("Plugin settings")}
          description={gt("Restore every setting of this plugin to its default.")}
          control={
            <SettingResetButton
              ariaLabel={gt("Reset {name} settings to default", { name: plugin.name })}
              onClick={() => save({ ...entry, config: {} })}
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function PluginFacts(props: { readonly plugin: PluginManifest }) {
  const { plugin } = props;
  const messages = useMessages();
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {plugin.panels.map((panel) => (
        <Badge key={panel.id} variant="secondary" size="sm">
          {panel.title}
          {panel.shortcut ? <Kbd>{panel.shortcut.toUpperCase()}</Kbd> : null}
        </Badge>
      ))}
      {(plugin.pages ?? []).map((page) => (
        <Badge key={`page:${page.id}`} variant="secondary" size="sm">
          {page.title}
        </Badge>
      ))}
      {(plugin.permissions ?? []).map((permission) => (
        <Badge key={permission} variant="info" size="sm">
          {messages(PERMISSION_LABELS[permission])}
        </Badge>
      ))}
      <span className="font-mono text-muted-foreground">{plugin.id}</span>
    </span>
  );
}

function PluginSettingRow(props: {
  readonly setting: PluginSetting;
  readonly stored: PluginConfigValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: PluginConfigValue) => void;
}) {
  const { setting } = props;
  const value = resolvePluginSettingValue(setting, props.stored);
  const edited = useRef(false);
  const common = {
    title: setting.label,
    description: setting.description,
  };

  switch (setting.type) {
    case "boolean":
      return (
        <SettingsRow
          {...common}
          control={
            <Switch
              checked={value === true}
              disabled={props.disabled}
              aria-label={setting.label}
              onCheckedChange={(checked) => props.onChange(Boolean(checked))}
            />
          }
        />
      );
    case "select":
      return (
        <SettingsRow
          {...common}
          control={
            <Select
              value={String(value)}
              disabled={props.disabled}
              onValueChange={(next) => {
                if (typeof next === "string") props.onChange(next);
              }}
            >
              <SelectTrigger size="sm" aria-label={setting.label}>
                <SelectValue>
                  {(selected: string | null) =>
                    setting.options.find((option) => option.value === selected)?.label ?? selected
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {setting.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      );
    case "number":
      return (
        <SettingsRow
          {...common}
          control={
            <Input
              key={String(value)}
              type="number"
              className="w-28"
              aria-label={setting.label}
              disabled={props.disabled}
              defaultValue={String(value)}
              {...(setting.min === undefined ? {} : { min: setting.min })}
              {...(setting.max === undefined ? {} : { max: setting.max })}
              {...(setting.step === undefined ? {} : { step: setting.step })}
              onBlur={(event) => {
                const parsed = Number(event.target.value);
                if (event.target.value.trim() === "" || !Number.isFinite(parsed)) {
                  event.target.value = String(value);
                  return;
                }
                const next = resolvePluginSettingValue(setting, parsed);
                event.target.value = String(next);
                if (next !== value) props.onChange(next);
              }}
            />
          }
        />
      );
    case "string": {
      const commit = (text: string) => {
        if (edited.current && text !== value) props.onChange(text);
        edited.current = false;
      };
      return setting.multiline ? (
        <SettingsRow {...common}>
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={String(value)}
              rows={4}
              aria-label={setting.label}
              disabled={props.disabled}
              defaultValue={String(value)}
              placeholder={setting.placeholder}
              onChange={() => {
                edited.current = true;
              }}
              onBlur={(event) => commit(event.target.value)}
            />
          </div>
        </SettingsRow>
      ) : (
        <SettingsRow
          {...common}
          control={
            <Input
              key={String(value)}
              aria-label={setting.label}
              disabled={props.disabled}
              defaultValue={String(value)}
              placeholder={setting.placeholder}
              onChange={() => {
                edited.current = true;
              }}
              onBlur={(event) => commit(event.target.value)}
            />
          }
        />
      );
    }
  }
}
