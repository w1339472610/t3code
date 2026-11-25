/**
 * A daily note is a Markdown outline: `- text`, `- [ ] todo`, `- [x] done`, `1. numbered`,
 * `- # heading`, `- > quote`, children indented under their parent, extra lines of a node indented
 * under its text, and a folded node ends with `<!-- collapsed -->`. Text inside a node is in
 * `noteInline.ts`.
 */

import { matchSequences } from "@t3tools/shared/lineMerge";

import {
  type NoteSegment,
  type NoteThreadSegment,
  parseInlineSegments,
  serializeInline,
} from "./noteInline";

export {
  deleteRange,
  insertSegments,
  normalizeSegments,
  type NoteSegment,
  type NoteThreadSegment,
  parseInlineSegments,
  segmentsKey,
  segmentsLength,
  splitSegments,
} from "./noteInline";

export type NoteTodo = "todo" | "done" | null;
/** How a node's line reads: plain, numbered, a heading, or a quote. */
export type NoteStyle = "text" | "ordered" | "h1" | "h2" | "h3" | "quote";

export interface NoteNode {
  readonly id: string;
  readonly segments: ReadonlyArray<NoteSegment>;
  readonly todo: NoteTodo;
  readonly style: NoteStyle;
  readonly collapsed: boolean;
  readonly children: ReadonlyArray<NoteNode>;
}

export type NoteTree = ReadonlyArray<NoteNode>;

let nextNodeId = 0;
function newNodeId(): string {
  nextNodeId += 1;
  return `n${nextNodeId.toString(36)}`;
}

export function makeNode(partial: Partial<Omit<NoteNode, "id">> = {}): NoteNode {
  return {
    id: newNodeId(),
    segments: partial.segments ?? [],
    todo: partial.todo ?? null,
    style: partial.style ?? "text",
    collapsed: partial.collapsed ?? false,
    children: partial.children ?? [],
  };
}

function segmentsPlainText(
  segments: ReadonlyArray<NoteSegment>,
  threadTitle: (segment: NoteThreadSegment) => string,
): string {
  return serializeInline(segments, (segment) => `@${threadTitle(segment)}`);
}

const BULLET = /^([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TODO = /^\[([ xX])\](?:[ \t]+|$)/;
const HEADING = /^(#{1,3})[ \t]+/;
const QUOTE = /^>[ \t]?/;
const COLLAPSED = /[ \t]*<!--\s*collapsed\s*-->[ \t]*$/;
const LOOKS_LIKE_BULLET = /^([-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function indentWidth(raw: string): number {
  let width = 0;
  for (const char of raw) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

interface MutableNode {
  id: string;
  lines: string[];
  todo: NoteTodo;
  style: NoteStyle;
  collapsed: boolean;
  children: MutableNode[];
  /** Columns before the bullet, and before the text. */
  indent: number;
  contentIndent: number;
}

function freeze(node: MutableNode): NoteNode {
  return {
    id: node.id,
    segments: parseInlineSegments(node.lines.join("\n").replace(/\n+$/, "")),
    todo: node.todo,
    style: node.style,
    collapsed: node.collapsed && node.children.length > 0,
    children: node.children.map(freeze),
  };
}

/** Reads any Markdown leniently: list items nest by indent, other lines become nodes too. */
export function parseNote(markdown: string): NoteNode[] {
  const roots: MutableNode[] = [];
  const stack: MutableNode[] = [];
  let lastNode: MutableNode | null = null;

  const place = (node: MutableNode) => {
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= node.indent) stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
    lastNode = node;
  };

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (rawLine.trim() === "") {
      const current = lastNode as MutableNode | null;
      if (current && current.lines.length > 0) current.lines.push("");
      continue;
    }
    const indent = indentWidth(rawLine);
    const body = rawLine.slice(rawLine.length - rawLine.trimStart().length);
    const current = lastNode as MutableNode | null;
    const bullet = BULLET.exec(body);
    if (current && indent >= current.contentIndent && !bullet) {
      const text =
        body.startsWith("\\") && LOOKS_LIKE_BULLET.test(body.slice(1)) ? body.slice(1) : body;
      current.lines.push(current.style === "quote" ? text.replace(QUOTE, "") : text);
      continue;
    }
    if (current) trimTrailingBlank(current);
    let text = bullet ? (bullet[2] ?? "") : body;
    let todo: NoteTodo = null;
    const todoMatch = bullet ? TODO.exec(text) : null;
    if (todoMatch) {
      todo = todoMatch[1] === " " ? "todo" : "done";
      text = text.slice(todoMatch[0].length);
    }
    let style: NoteStyle = bullet && /^\d/.test(bullet[1] ?? "") ? "ordered" : "text";
    const heading = HEADING.exec(text);
    if (heading) {
      style = heading[1]!.length === 1 ? "h1" : heading[1]!.length === 2 ? "h2" : "h3";
      text = text.slice(heading[0].length);
    } else if (QUOTE.test(text)) {
      style = "quote";
      text = text.replace(QUOTE, "");
    }
    const collapsed = COLLAPSED.test(text);
    if (collapsed) text = text.replace(COLLAPSED, "");
    const markerWidth = bullet ? (bullet[1]?.length ?? 1) + 1 : 0;
    place({
      id: newNodeId(),
      lines: [text],
      todo,
      style,
      collapsed,
      children: [],
      indent,
      contentIndent: indent + Math.max(markerWidth, 1),
    });
  }
  const last = lastNode as MutableNode | null;
  if (last) trimTrailingBlank(last);
  return roots.map(freeze);
}

function trimTrailingBlank(node: MutableNode) {
  while (node.lines.length > 1 && node.lines.at(-1) === "") node.lines.pop();
}

const STYLE_PREFIX: Record<NoteStyle, string> = {
  text: "",
  ordered: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
};

export function serializeNote(tree: NoteTree): string {
  const lines: string[] = [];
  const walk = (nodes: NoteTree, pad: string) => {
    let ordinal = 0;
    for (const node of nodes) {
      ordinal = node.style === "ordered" ? ordinal + 1 : 0;
      const marker = node.style === "ordered" ? `${ordinal}.` : "-";
      const todo = node.todo === "todo" ? "[ ] " : node.todo === "done" ? "[x] " : "";
      const [first = "", ...rest] = serializeInline(node.segments).split("\n");
      const fold = node.collapsed && node.children.length > 0 ? " <!-- collapsed -->" : "";
      // A plain line that starts like a heading or quote keeps reading as text.
      const head = node.style === "text" && /^(#{1,3}[ \t]|>)/.test(first) ? `\\${first}` : first;
      lines.push(`${pad}${marker} ${todo}${STYLE_PREFIX[node.style]}${head}${fold}`.trimEnd());
      const inner = pad + " ".repeat(marker.length + 1);
      for (const line of rest) {
        if (line.trim() === "") {
          lines.push(node.style === "quote" ? `${inner}>` : "");
          continue;
        }
        const escaped = LOOKS_LIKE_BULLET.test(line) ? `\\${line}` : line;
        lines.push(`${inner}${node.style === "quote" ? `> ${line}` : escaped}`);
      }
      walk(node.children, inner);
    }
  };
  walk(tree, "");
  if (lines.every((line) => /^\s*(-|\d+\.)$/.test(line))) return "";
  return `${lines.join("\n")}\n`;
}

export interface NodeLocation {
  readonly node: NoteNode;
  readonly parentId: string | null;
  readonly index: number;
  readonly siblings: ReadonlyArray<NoteNode>;
  readonly depth: number;
}

export function locate(tree: NoteTree, id: string): NodeLocation | null {
  const visit = (
    nodes: ReadonlyArray<NoteNode>,
    parentId: string | null,
    depth: number,
  ): NodeLocation | null => {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (node.id === id) return { node, parentId, index, siblings: nodes, depth };
      const found = visit(node.children, node.id, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(tree, null, 0);
}

export interface VisibleRow {
  readonly node: NoteNode;
  readonly depth: number;
  readonly parentId: string | null;
  /** The number a numbered node shows; runs of numbered siblings count from 1. */
  readonly ordinal: number | null;
}

export function visibleRows(tree: NoteTree): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: ReadonlyArray<NoteNode>, depth: number, parentId: string | null) => {
    let ordinal = 0;
    for (const node of nodes) {
      ordinal = node.style === "ordered" ? ordinal + 1 : 0;
      rows.push({ node, depth, parentId, ordinal: node.style === "ordered" ? ordinal : null });
      if (!node.collapsed) walk(node.children, depth + 1, node.id);
    }
  };
  walk(tree, 0, null);
  return rows;
}

function mapChildren(
  tree: NoteTree,
  parentId: string | null,
  fn: (children: ReadonlyArray<NoteNode>) => ReadonlyArray<NoteNode>,
): NoteNode[] {
  if (parentId === null) return [...fn(tree)];
  return tree.map((node) =>
    node.id === parentId
      ? { ...node, children: fn(node.children) }
      : node.children.length === 0
        ? node
        : { ...node, children: mapChildren(node.children, parentId, fn) },
  );
}

export function updateNode(
  tree: NoteTree,
  id: string,
  fn: (node: NoteNode) => NoteNode,
): NoteNode[] {
  return tree.map((node) =>
    node.id === id
      ? fn(node)
      : node.children.length === 0
        ? node
        : { ...node, children: updateNode(node.children, id, fn) },
  );
}

export function removeNode(tree: NoteTree, id: string): NoteNode[] {
  const location = locate(tree, id);
  if (!location) return [...tree];
  return mapChildren(tree, location.parentId, (children) =>
    children.filter((child) => child.id !== id),
  );
}

export function insertNodes(
  tree: NoteTree,
  parentId: string | null,
  index: number,
  nodes: ReadonlyArray<NoteNode>,
): NoteNode[] {
  return mapChildren(tree, parentId, (children) => [
    ...children.slice(0, index),
    ...nodes,
    ...children.slice(index),
  ]);
}

export function insertAfter(tree: NoteTree, id: string, node: NoteNode): NoteNode[] {
  const location = locate(tree, id);
  if (!location) return [...tree, node];
  return insertNodes(tree, location.parentId, location.index + 1, [node]);
}

/** Becomes the last child of the previous sibling, which opens if folded. */
export function indentNode(tree: NoteTree, id: string): NoteNode[] | null {
  const location = locate(tree, id);
  if (!location || location.index === 0) return null;
  const previous = location.siblings[location.index - 1]!;
  const without = removeNode(tree, id);
  return updateNode(without, previous.id, (node) => ({
    ...node,
    collapsed: false,
    children: [...node.children, location.node],
  }));
}

/** Moves after its parent; the siblings that followed it become its children. */
export function outdentNode(tree: NoteTree, id: string): NoteNode[] | null {
  const location = locate(tree, id);
  if (!location || location.parentId === null) return null;
  const parentLocation = locate(tree, location.parentId)!;
  const following = location.siblings.slice(location.index + 1);
  const moved: NoteNode = {
    ...location.node,
    collapsed: following.length > 0 ? false : location.node.collapsed,
    children: [...location.node.children, ...following],
  };
  let next = mapChildren(tree, location.parentId, (children) => children.slice(0, location.index));
  next = insertNodes(next, parentLocation.parentId, parentLocation.index + 1, [moved]);
  return next;
}

export function moveAmongSiblings(tree: NoteTree, id: string, delta: -1 | 1): NoteNode[] | null {
  const location = locate(tree, id);
  if (!location) return null;
  const target = location.index + delta;
  if (target < 0 || target >= location.siblings.length) return null;
  return mapChildren(tree, location.parentId, (children) => {
    const next = [...children];
    const [moved] = next.splice(location.index, 1);
    next.splice(target, 0, moved!);
    return next;
  });
}

export function cycleTodo(todo: NoteTodo): NoteTodo {
  return todo === null ? "todo" : todo === "todo" ? "done" : null;
}

export function setCollapsed(tree: NoteTree, id: string, collapsed: boolean): NoteNode[] {
  return updateNode(tree, id, (node) =>
    node.children.length === 0 ? node : { ...node, collapsed },
  );
}

/** Ids in `ids` whose ancestors are not also in `ids`, in document order. */
export function topLevelSelection(tree: NoteTree, ids: ReadonlySet<string>): NoteNode[] {
  const out: NoteNode[] = [];
  const walk = (nodes: ReadonlyArray<NoteNode>) => {
    for (const node of nodes) {
      if (ids.has(node.id)) out.push(node);
      else walk(node.children);
    }
  };
  walk(tree);
  return out;
}

export function removeNodes(tree: NoteTree, ids: Iterable<string>): NoteNode[] {
  let next = [...tree];
  for (const id of ids) next = removeNode(next, id);
  return next;
}

/** Moves whole subtrees to `index` among `parentId`'s children, counted after their removal. */
export function moveNodes(
  tree: NoteTree,
  nodes: ReadonlyArray<NoteNode>,
  parentId: string | null,
  index: number,
): NoteNode[] {
  let next = removeNodes(
    tree,
    nodes.map((node) => node.id),
  );
  if (parentId !== null && !locate(next, parentId)) return [...tree];
  next = insertNodes(next, parentId, index, nodes);
  return parentId === null
    ? next
    : updateNode(next, parentId, (node) => ({ ...node, collapsed: false }));
}

/** Plain text for copying or a prompt: two spaces per level, todos as Markdown task markers. */
export function nodesToMarkdown(nodes: ReadonlyArray<NoteNode>): string {
  return serializeNote(nodes);
}

/** Prompt text: the node's own text, then its subtree as an indented list. */
export function nodePromptText(
  node: NoteNode,
  threadTitle: (segment: NoteThreadSegment) => string,
): string {
  const lines = [segmentsPlainText(node.segments, threadTitle)];
  const walk = (nodes: ReadonlyArray<NoteNode>, depth: number) => {
    for (const child of nodes) {
      const todo = child.todo === "todo" ? "[ ] " : child.todo === "done" ? "[x] " : "";
      const text = segmentsPlainText(child.segments, threadTitle).replace(
        /\n/g,
        `\n${"  ".repeat(depth + 1)}`,
      );
      lines.push(`${"  ".repeat(depth)}- ${todo}${text}`);
      walk(child.children, depth + 1);
    }
  };
  walk(node.children, 0);
  return lines.join("\n").trim();
}

export interface DropTarget {
  /** The new parent; null for the day's top level. */
  readonly parentId: string | null;
  /** Insert after this sibling; null inserts first. */
  readonly afterId: string | null;
}

/** Moves whole subtrees to a drop target; refuses targets inside the moved nodes. */
export function moveNodesTo(
  tree: NoteTree,
  nodes: ReadonlyArray<NoteNode>,
  target: DropTarget,
): NoteNode[] | null {
  const movedIds = new Set<string>();
  const collect = (node: NoteNode) => {
    movedIds.add(node.id);
    node.children.forEach(collect);
  };
  nodes.forEach(collect);
  if (target.parentId !== null && movedIds.has(target.parentId)) return null;
  if (target.afterId !== null && movedIds.has(target.afterId)) return null;
  return insertAtTarget(
    removeNodes(
      tree,
      nodes.map((node) => node.id),
    ),
    nodes,
    target,
  );
}

export function insertAtTarget(
  tree: NoteTree,
  nodes: ReadonlyArray<NoteNode>,
  target: DropTarget,
): NoteNode[] | null {
  if (target.afterId !== null) {
    const anchor = locate(tree, target.afterId);
    if (!anchor) return null;
    return insertNodes(tree, anchor.parentId, anchor.index + 1, nodes);
  }
  if (target.parentId !== null && !locate(tree, target.parentId)) return null;
  const next = insertNodes(tree, target.parentId, 0, nodes);
  return target.parentId === null
    ? next
    : updateNode(next, target.parentId, (node) => ({ ...node, collapsed: false }));
}

/**
 * Gives the nodes of a reloaded `next` the ids of their counterparts in
 * `previous`, so rows keep focus and the caret when the file changes outside
 * this client. `changed` holds the ids whose line is new or different.
 */
export function adoptIds(
  previous: NoteTree,
  next: NoteTree,
): { readonly tree: NoteTree; readonly changed: ReadonlySet<string> } {
  const flatten = (tree: NoteTree) => {
    const entries: Array<{ node: NoteNode; key: string }> = [];
    const walk = (nodes: NoteTree, depth: number) => {
      for (const node of nodes) {
        const line = serializeNote([{ ...node, children: [], collapsed: false }]);
        entries.push({ node, key: `${depth}:${line}` });
        walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return entries;
  };
  const before = flatten(previous);
  const after = flatten(next);
  const matches = matchSequences(
    after.map((entry) => entry.key),
    before.map((entry) => entry.key),
  );
  const ids = new Map<NoteNode, string>();
  // An unchanged line keeps its segments array, so its editor is not repainted mid-composition.
  const kept = new Map<NoteNode, NoteNode>();
  const changed = new Set<string>();
  let lastMatched = -1;
  let gap: number[] = [];
  // Unmatched lines between two matches take the old ids of that stretch in order: an edited line stays the same row.
  const closeGap = (until: number) => {
    gap.forEach((index, offset) => {
      const candidate = lastMatched + 1 + offset;
      const id = candidate < until ? before[candidate]!.node.id : after[index]!.node.id;
      ids.set(after[index]!.node, id);
      changed.add(id);
    });
    gap = [];
  };
  after.forEach((entry, index) => {
    const match = matches[index]!;
    if (match < 0) {
      gap.push(index);
      return;
    }
    closeGap(match);
    ids.set(entry.node, before[match]!.node.id);
    kept.set(entry.node, before[match]!.node);
    lastMatched = match;
  });
  closeGap(before.length);
  const rebuild = (nodes: NoteTree): NoteNode[] =>
    nodes.map((node) => ({
      ...node,
      id: ids.get(node) ?? node.id,
      segments: kept.get(node)?.segments ?? node.segments,
      children: rebuild(node.children),
    }));
  return { tree: rebuild(next), changed };
}
