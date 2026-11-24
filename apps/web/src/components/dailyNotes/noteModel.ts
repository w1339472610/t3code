/**
 * A daily note is a Markdown outline: `- text`, `- [ ] todo`, `- [x] done`, children indented two
 * spaces, extra lines of a node indented under its text, a folded node ends with `<!-- collapsed -->`,
 * and thread mentions are `[@title](t3://thread/<environmentId>/<threadId>)`.
 */

export interface NoteTextSegment {
  readonly kind: "text";
  readonly text: string;
}

export interface NoteThreadSegment {
  readonly kind: "thread";
  readonly environmentId: string;
  readonly threadId: string;
  /** The title when the mention was written; the live title wins while the thread exists. */
  readonly title: string;
}

export type NoteSegment = NoteTextSegment | NoteThreadSegment;
export type NoteTodo = "todo" | "done" | null;

export interface NoteNode {
  readonly id: string;
  readonly segments: ReadonlyArray<NoteSegment>;
  readonly todo: NoteTodo;
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
    collapsed: partial.collapsed ?? false,
    children: partial.children ?? [],
  };
}

function segmentLength(segment: NoteSegment): number {
  return segment.kind === "text" ? segment.text.length : 1;
}

export function segmentsLength(segments: ReadonlyArray<NoteSegment>): number {
  let total = 0;
  for (const segment of segments) total += segmentLength(segment);
  return total;
}

/** Merges adjacent text and drops empty text. */
export function normalizeSegments(segments: ReadonlyArray<NoteSegment>): NoteSegment[] {
  const out: NoteSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      if (segment.text.length === 0) continue;
      const last = out.at(-1);
      if (last?.kind === "text") {
        out[out.length - 1] = { kind: "text", text: last.text + segment.text };
        continue;
      }
    }
    out.push(segment);
  }
  return out;
}

export function splitSegments(
  segments: ReadonlyArray<NoteSegment>,
  offset: number,
): [NoteSegment[], NoteSegment[]] {
  const left: NoteSegment[] = [];
  const right: NoteSegment[] = [];
  let position = 0;
  for (const segment of segments) {
    const length = segmentLength(segment);
    if (position + length <= offset) left.push(segment);
    else if (position >= offset) right.push(segment);
    else if (segment.kind === "text") {
      const cut = offset - position;
      left.push({ kind: "text", text: segment.text.slice(0, cut) });
      right.push({ kind: "text", text: segment.text.slice(cut) });
    }
    position += length;
  }
  return [normalizeSegments(left), normalizeSegments(right)];
}

function segmentsPlainText(
  segments: ReadonlyArray<NoteSegment>,
  threadTitle: (segment: NoteThreadSegment) => string = (segment) => segment.title,
): string {
  return segments
    .map((segment) => (segment.kind === "text" ? segment.text : `@${threadTitle(segment)}`))
    .join("");
}

const THREAD_LINK = /\[@([^\]\n]*)\]\(t3:\/\/thread\/([^/\s)]+)\/([^/\s)]+)\)/g;
const BULLET = /^([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TODO = /^\[([ xX])\](?:[ \t]+|$)/;
const COLLAPSED = /[ \t]*<!--\s*collapsed\s*-->[ \t]*$/;
const LOOKS_LIKE_BULLET = /^([-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function threadLink(environmentId: string, threadId: string): string {
  return `t3://thread/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseInlineSegments(text: string): NoteSegment[] {
  const segments: NoteSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(THREAD_LINK)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", text: text.slice(last, index) });
    segments.push({
      kind: "thread",
      title: match[1] ?? "",
      environmentId: safeDecode(match[2] ?? ""),
      threadId: safeDecode(match[3] ?? ""),
    });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return normalizeSegments(segments);
}

function serializeInline(segments: ReadonlyArray<NoteSegment>): string {
  return segments
    .map((segment) =>
      segment.kind === "text"
        ? segment.text
        : `[@${segment.title.replace(/[[\]\n]/g, " ").trim()}](${threadLink(
            segment.environmentId,
            segment.threadId,
          )})`,
    )
    .join("");
}

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
      current.lines.push(text);
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
    const collapsed = COLLAPSED.test(text);
    if (collapsed) text = text.replace(COLLAPSED, "");
    const markerWidth = bullet ? (bullet[1]?.length ?? 1) + 1 : 0;
    place({
      id: newNodeId(),
      lines: [text],
      todo,
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

export function serializeNote(tree: NoteTree): string {
  const lines: string[] = [];
  const walk = (nodes: NoteTree, depth: number) => {
    for (const node of nodes) {
      const pad = "  ".repeat(depth);
      const todo = node.todo === "todo" ? "[ ] " : node.todo === "done" ? "[x] " : "";
      const [first = "", ...rest] = serializeInline(node.segments).split("\n");
      const fold = node.collapsed && node.children.length > 0 ? " <!-- collapsed -->" : "";
      lines.push(`${pad}- ${todo}${first}${fold}`.trimEnd());
      for (const line of rest) {
        if (line.trim() === "") {
          lines.push("");
          continue;
        }
        lines.push(`${pad}  ${LOOKS_LIKE_BULLET.test(line) ? `\\${line}` : line}`);
      }
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  if (lines.every((line) => line.trim() === "-")) return "";
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
}

export function visibleRows(tree: NoteTree): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: ReadonlyArray<NoteNode>, depth: number, parentId: string | null) => {
    for (const node of nodes) {
      rows.push({ node, depth, parentId });
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

export function deleteRange(
  segments: ReadonlyArray<NoteSegment>,
  start: number,
  end: number,
): NoteSegment[] {
  if (end <= start) return [...segments];
  const [left] = splitSegments(segments, start);
  const [, right] = splitSegments(segments, end);
  return normalizeSegments([...left, ...right]);
}

export function insertSegments(
  segments: ReadonlyArray<NoteSegment>,
  offset: number,
  inserted: ReadonlyArray<NoteSegment>,
): NoteSegment[] {
  const [left, right] = splitSegments(segments, offset);
  return normalizeSegments([...left, ...inserted, ...right]);
}

export function segmentsKey(segments: ReadonlyArray<NoteSegment>): string {
  return JSON.stringify(segments);
}
