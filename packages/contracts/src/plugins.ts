import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
export type PluginId = typeof PluginId.Type;

export const PluginPermission = Schema.Literals([
  "thread:read",
  "thread:navigate",
  "scheduledTasks:read",
]);
export type PluginPermission = typeof PluginPermission.Type;

export const PluginPanel = Schema.Struct({
  id: PluginId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** Relative to the plugin folder. */
  entry: TrimmedNonEmptyString.check(Schema.isMaxLength(512), Schema.isPattern(/\.html?$/i)),
  shortcut: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z]$/))),
});
export type PluginPanel = typeof PluginPanel.Type;

/** Icons a plugin page can show in the sidebar; T3 draws them so they match its own. */
export const PluginPageIcon = Schema.Literals([
  "puzzle",
  "calendar",
  "calendar-clock",
  "list-checks",
  "layout-dashboard",
  "chart",
  "book",
]);
export type PluginPageIcon = typeof PluginPageIcon.Type;

/** A full window page, opened from the sidebar like Usage. */
export const PluginPage = Schema.Struct({
  id: PluginId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  entry: PluginPanel.fields.entry,
  icon: Schema.optionalKey(PluginPageIcon),
});
export type PluginPage = typeof PluginPage.Type;

const PLUGIN_TEXT_MAX_LENGTH = 2000;

const PluginSettingFields = {
  key: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
};

/** A setting a plugin declares; T3 renders it in Settings → Plugins and hands the value to the plugin. */
export const PluginSetting = Schema.Union([
  Schema.Struct({
    ...PluginSettingFields,
    type: Schema.Literal("boolean"),
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...PluginSettingFields,
    type: Schema.Literal("string"),
    default: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(PLUGIN_TEXT_MAX_LENGTH))),
    placeholder: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
    multiline: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...PluginSettingFields,
    type: Schema.Literal("number"),
    default: Schema.optionalKey(Schema.Finite),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
    step: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    ...PluginSettingFields,
    type: Schema.Literal("select"),
    default: Schema.optionalKey(Schema.String),
    options: Schema.Array(
      Schema.Struct({
        value: Schema.String.check(Schema.isMaxLength(120)),
        label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }),
]);
export type PluginSetting = typeof PluginSetting.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  permissions: Schema.optionalKey(Schema.Array(PluginPermission)),
  panels: Schema.Array(PluginPanel).check(Schema.isMaxLength(16)),
  pages: Schema.optionalKey(Schema.Array(PluginPage).check(Schema.isMaxLength(8))),
  settings: Schema.optionalKey(Schema.Array(PluginSetting).check(Schema.isMaxLength(32))),
});
export type PluginManifest = typeof PluginManifest.Type;

/** A plugin folder that could not be loaded, and why. */
export const PluginLoadIssue = Schema.Struct({
  folder: Schema.String,
  message: Schema.String,
});
export type PluginLoadIssue = typeof PluginLoadIssue.Type;

export const PluginsSnapshot = Schema.Struct({
  directory: Schema.String,
  plugins: Schema.Array(PluginManifest),
  issues: Schema.Array(PluginLoadIssue),
});
export type PluginsSnapshot = typeof PluginsSnapshot.Type;

export const PluginConfigValue = Schema.Union([
  Schema.Boolean,
  Schema.Finite,
  Schema.String.check(Schema.isMaxLength(PLUGIN_TEXT_MAX_LENGTH)),
]);
export type PluginConfigValue = typeof PluginConfigValue.Type;

/** What the user chose for one plugin; a missing entry means enabled with default settings. */
export const PluginSettingsEntry = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Record(Schema.String, PluginConfigValue)),
});
export type PluginSettingsEntry = typeof PluginSettingsEntry.Type;

export function isPluginEnabled(
  entries: Readonly<Record<string, PluginSettingsEntry>> | undefined,
  pluginId: string,
): boolean {
  return entries?.[pluginId]?.enabled !== false;
}

/** The value a setting resolves to: a stored value of the declared shape, else its default. */
export function resolvePluginSettingValue(
  setting: PluginSetting,
  stored: PluginConfigValue | undefined,
): PluginConfigValue {
  switch (setting.type) {
    case "boolean":
      return typeof stored === "boolean" ? stored : (setting.default ?? false);
    case "string":
      return typeof stored === "string" ? stored : (setting.default ?? "");
    case "number": {
      const value = typeof stored === "number" ? stored : (setting.default ?? setting.min ?? 0);
      return Math.min(setting.max ?? Infinity, Math.max(setting.min ?? -Infinity, value));
    }
    case "select": {
      const known = (value: unknown) => setting.options.some((option) => option.value === value);
      if (typeof stored === "string" && known(stored)) return stored;
      return setting.default !== undefined && known(setting.default)
        ? setting.default
        : (setting.options[0]?.value ?? "");
    }
  }
}

export function resolvePluginConfig(
  manifest: Pick<PluginManifest, "settings">,
  entry: PluginSettingsEntry | undefined,
): Record<string, PluginConfigValue> {
  return Object.fromEntries(
    (manifest.settings ?? []).map((setting) => [
      setting.key,
      resolvePluginSettingValue(setting, entry?.config?.[setting.key]),
    ]),
  );
}
