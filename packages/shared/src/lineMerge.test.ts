import { describe, expect, it } from "vite-plus/test";

import { matchSequences, mergeLines } from "./lineMerge.ts";

const lines = (...items: string[]) => `${items.join("\n")}\n`;

describe("mergeLines", () => {
  it.each([
    {
      name: "keeps both sides' edits to different lines",
      base: lines("- a", "- b", "- c"),
      ours: lines("- a!", "- b", "- c"),
      theirs: lines("- a", "- b", "- c!"),
      merged: lines("- a!", "- b", "- c!"),
    },
    {
      name: "keeps both sides' edits to neighbouring lines",
      base: lines("- [ ] a", "- b", "- c"),
      ours: lines("- [ ] a", "- b typed", "- c"),
      theirs: lines("- [x] a", "- b", "- c", "- [ ] new"),
      merged: lines("- [x] a", "- b typed", "- c", "- [ ] new"),
    },
    {
      name: "keeps lines both sides added in different places",
      base: lines("- a", "- b"),
      ours: lines("- a", "  - a1", "- b"),
      theirs: lines("- a", "- b", "- [ ] new"),
      merged: lines("- a", "  - a1", "- b", "- [ ] new"),
    },
    {
      name: "keeps their deletion when ours left the line alone",
      base: lines("- a", "- b", "- c"),
      ours: lines("- a", "- b", "- c", "- d"),
      theirs: lines("- a", "- c"),
      merged: lines("- a", "- c", "- d"),
    },
    {
      name: "keeps both versions of a line both sides changed, ours first",
      base: lines("- a", "- b"),
      ours: lines("- a", "- b typed"),
      theirs: lines("- a", "- [x] b"),
      merged: lines("- a", "- b typed", "- [x] b"),
    },
    {
      name: "adds a line once when both sides added it",
      base: lines("- a"),
      ours: lines("- a", "- same"),
      theirs: lines("- a", "- same"),
      merged: lines("- a", "- same"),
    },
    {
      name: "fills an empty day from both sides",
      base: "",
      ours: lines("- mine"),
      theirs: lines("- theirs"),
      merged: lines("- mine", "- theirs"),
    },
  ])("$name", ({ base, ours, theirs, merged }) => {
    expect(mergeLines(base, ours, theirs)).toBe(merged);
  });
});

describe("matchSequences", () => {
  it("matches the longest common subsequence in order", () => {
    expect(Array.from(matchSequences(["a", "b", "c", "d"], ["b", "x", "d", "a"]))).toEqual([
      -1, 0, -1, 2,
    ]);
  });
});
