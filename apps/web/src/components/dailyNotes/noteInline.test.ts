import { describe, expect, it } from "vite-plus/test";

import {
  applyTypingShortcut,
  linkAt,
  type NoteSegment,
  parseInlineSegments,
  serializeInline,
  toggleMark,
} from "./noteInline";

const t = (text: string, marks?: Record<string, unknown>): NoteSegment =>
  marks ? ({ kind: "text", text, marks } as NoteSegment) : { kind: "text", text };

describe("inline Markdown", () => {
  it("reads marks, links, bare URLs and escapes", () => {
    expect(
      parseInlineSegments(
        "**重要**的 *斜* ~~删~~ `a*b` [文档](https://x.dev) 见 https://a.com/p_q。 \\*字面\\* snake_case_name",
      ),
    ).toEqual([
      t("重要", { bold: true }),
      t("的 "),
      t("斜", { italic: true }),
      t(" "),
      t("删", { strike: true }),
      t(" "),
      t("a*b", { code: true }),
      t(" "),
      t("文档", { href: "https://x.dev" }),
      t(" 见 "),
      t("https://a.com/p_q", { href: "https://a.com/p_q" }),
      t("。 *字面* snake_case_name"),
    ]);
  });

  it("writes back what it reads", () => {
    for (const source of [
      "**bold** and _italic_ and **_both_**",
      "**结束**_后缀斜体_普通",
      "**a_b_**",
      "in*side*word",
      "~~gone~~ `code` [label **strong**](https://x.dev/a)",
      "see https://a.com/x_y today",
      "\\*not italic\\* and 2 \\* 3 \\* 4",
      "`` a`b `` mixed",
      "[@Fix login](t3://thread/env-1/thread-9) next",
    ]) {
      expect(serializeInline(parseInlineSegments(source))).toBe(source);
    }
  });

  it("keeps spaces outside marks so they read back", () => {
    expect(serializeInline([t("a"), t(" b ", { bold: true }), t("c")])).toBe("a **b** c");
  });

  it("toggles a mark off only when the whole range has it", () => {
    const half = toggleMark([t("hello world")], 0, 5, "bold");
    expect(half).toEqual([t("hello", { bold: true }), t(" world")]);
    expect(toggleMark(half, 0, 11, "bold")).toEqual([t("hello world", { bold: true })]);
    expect(toggleMark(half, 0, 5, "bold")).toEqual([t("hello world")]);
  });

  it("finds the whole link around a caret", () => {
    const segments = parseInlineSegments("go [the **docs**](https://x.dev) now");
    expect(linkAt(segments, 5)).toEqual({ start: 3, end: 11, href: "https://x.dev" });
    expect(linkAt(segments, 1)).toBeNull();
  });

  it("applies typed Markdown when its closing character lands", () => {
    expect(applyTypingShortcut([t("a **b**")], 7)).toEqual({
      segments: [t("a "), t("b", { bold: true })],
      caret: 3,
    });
    expect(applyTypingShortcut([t("x `c`")], 5)?.segments).toEqual([
      t("x "),
      t("c", { code: true }),
    ]);
    expect(applyTypingShortcut([t("[l](https://x.dev)")], 18)?.segments).toEqual([
      t("l", { href: "https://x.dev" }),
    ]);
    expect(applyTypingShortcut([t("go https://x.dev ")], 17)).toEqual({
      segments: [t("go "), t("https://x.dev", { href: "https://x.dev" }), t(" ")],
      caret: 17,
    });
    expect(applyTypingShortcut([t("2 * 3 * 4")], 9)).toBeNull();
  });
});
