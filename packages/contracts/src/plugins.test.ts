import { describe, expect, it } from "vite-plus/test";

import { isPluginEnabled, resolvePluginConfig, type PluginSetting } from "./plugins.ts";

const settings: ReadonlyArray<PluginSetting> = [
  { key: "show", type: "boolean", label: "Show", default: true },
  { key: "max", type: "number", label: "Max", default: 8, min: 1, max: 50 },
  {
    key: "mode",
    type: "select",
    label: "Mode",
    default: "show",
    options: [
      { value: "show", label: "Show" },
      { value: "hide", label: "Hide" },
    ],
  },
  { key: "note", type: "string", label: "Note" },
];

describe("resolvePluginConfig", () => {
  it("uses defaults until the user chooses, and drops values of the wrong shape", () => {
    expect(resolvePluginConfig({ settings }, undefined)).toEqual({
      show: true,
      max: 8,
      mode: "show",
      note: "",
    });
    expect(
      resolvePluginConfig(
        { settings },
        { config: { show: "yes", max: 500, mode: "gone", note: "hi", stray: 1 } },
      ),
    ).toEqual({ show: true, max: 50, mode: "show", note: "hi" });
    expect(resolvePluginConfig({ settings }, { config: { show: false, mode: "hide" } })).toEqual({
      show: false,
      max: 8,
      mode: "hide",
      note: "",
    });
  });
});

describe("isPluginEnabled", () => {
  it("treats a plugin without an entry as on", () => {
    expect(isPluginEnabled({}, "progress")).toBe(true);
    expect(isPluginEnabled({ progress: { config: {} } }, "progress")).toBe(true);
    expect(isPluginEnabled({ progress: { enabled: false } }, "progress")).toBe(false);
  });
});
