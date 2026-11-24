import { describe, expect, it } from "vite-plus/test";

import {
  indentNode,
  locate,
  moveNodes,
  type NoteNode,
  outdentNode,
  parseNote,
  serializeNote,
  splitSegments,
} from "./noteModel";

function shape(nodes: ReadonlyArray<NoteNode>): unknown[] {
  return nodes.map((node) => ({
    text: node.segments.map((s) => (s.kind === "text" ? s.text : `@${s.threadId}`)).join(""),
    ...(node.todo ? { todo: node.todo } : {}),
    ...(node.collapsed ? { collapsed: true } : {}),
    ...(node.children.length > 0 ? { children: shape(node.children) } : {}),
  }));
}

describe("parseNote / serializeNote", () => {
  it("round-trips todos, nesting, folds, mentions and multi-line text", () => {
    const markdown = [
      "- plan the day",
      "  - [ ] ship [@Fix login](t3://thread/env-1/thread-9) today",
      "  - [x] review",
      "- parent <!-- collapsed -->",
      "  - child",
      "- two lines",
      "  second line",
      "  \\- not a bullet",
      "",
    ].join("\n");
    const tree = parseNote(markdown);
    expect(shape(tree)).toEqual([
      {
        text: "plan the day",
        children: [
          { text: "ship @thread-9 today", todo: "todo" },
          { text: "review", todo: "done" },
        ],
      },
      { text: "parent", collapsed: true, children: [{ text: "child" }] },
      { text: "two lines\nsecond line\n- not a bullet" },
    ]);
    expect(serializeNote(tree)).toBe(markdown);
  });

  it("reads tab-indented lists, numbered items and loose paragraphs", () => {
    const tree = parseNote("# Heading\n1. one\n\t- nested\n* star\n");
    expect(shape(tree)).toEqual([
      { text: "# Heading" },
      { text: "one", children: [{ text: "nested" }] },
      { text: "star" },
    ]);
  });

  it("writes nothing for a note of empty rows", () => {
    expect(serializeNote(parseNote("-\n-\n"))).toBe("");
  });
});

describe("tree edits", () => {
  it("outdent adopts the following siblings; indent undoes it", () => {
    const tree = parseNote("- a\n  - b\n  - c\n  - d\n");
    const b = locate(tree, tree[0]!.children[0]!.id)!.node;
    const c = tree[0]!.children[1]!;
    const out = outdentNode(tree, c.id)!;
    expect(shape(out)).toEqual([
      { text: "a", children: [{ text: "b" }] },
      { text: "c", children: [{ text: "d" }] },
    ]);
    expect(shape(indentNode(out, c.id)!)).toEqual([
      { text: "a", children: [{ text: "b" }, { text: "c", children: [{ text: "d" }] }] },
    ]);
    expect(indentNode(tree, b.id)).toBeNull();
  });

  it("moves subtrees under a new parent", () => {
    const tree = parseNote("- a\n- b\n  - b1\n- c\n");
    const moved = moveNodes(tree, [tree[1]!], tree[2]!.id, 0);
    expect(shape(moved)).toEqual([
      { text: "a" },
      { text: "c", children: [{ text: "b", children: [{ text: "b1" }] }] },
    ]);
  });

  it("splits text around a mention, which counts as one character", () => {
    const segments = parseNote("- ab[@T](t3://thread/e/t)cd\n")[0]!.segments;
    const [left, right] = splitSegments(segments, 3);
    expect(left).toEqual([
      { kind: "text", text: "ab" },
      { kind: "thread", environmentId: "e", threadId: "t", title: "T" },
    ]);
    expect(right).toEqual([{ kind: "text", text: "cd" }]);
  });
});
