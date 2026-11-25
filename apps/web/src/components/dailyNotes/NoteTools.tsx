import {
  BoldIcon,
  CodeIcon,
  ExternalLinkIcon,
  ItalicIcon,
  LinkIcon,
  PencilIcon,
  StrikethroughIcon,
  UnlinkIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import type { MessageResolver } from "~/i18n/messages";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { readDayTree, requestFocus } from "./dailyNotesStore";
import {
  linkRangeAt,
  type NoteRange,
  normalizeHref,
  openNoteLink,
  selectedRange,
  setRangeLink,
  toggleRangeMark,
} from "./noteFormat";
import { type NoteMarkName, rangeHasMark } from "./noteInline";
import { locate, type NoteStyle, type NoteTodo } from "./noteModel";

export interface SlashCommand {
  readonly id: string;
  /** A `msg()` descriptor; resolve it with `useMessages()` in render. */
  readonly label: string;
  /** What to type at a line start for the same result. */
  readonly hint: string;
  readonly keywords: ReadonlyArray<string>;
  readonly style?: NoteStyle;
  readonly todo?: NoteTodo;
}

const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    id: "text",
    label: msg("Text"),
    hint: "",
    keywords: ["text", "plain", "正文", "文本"],
    style: "text",
    todo: null,
  },
  {
    id: "h1",
    label: msg("Heading 1"),
    hint: "#",
    keywords: ["h1", "heading", "title", "标题", "一级标题"],
    style: "h1",
  },
  {
    id: "h2",
    label: msg("Heading 2"),
    hint: "##",
    keywords: ["h2", "heading", "标题", "二级标题"],
    style: "h2",
  },
  {
    id: "h3",
    label: msg("Heading 3"),
    hint: "###",
    keywords: ["h3", "heading", "标题", "三级标题"],
    style: "h3",
  },
  {
    id: "ordered",
    label: msg("Numbered list"),
    hint: "1.",
    keywords: ["ol", "numbered", "list", "有序", "编号", "列表"],
    style: "ordered",
  },
  {
    id: "todo",
    label: msg("To-do"),
    hint: "[]",
    keywords: ["todo", "task", "check", "待办", "任务"],
    todo: "todo",
  },
  { id: "quote", label: msg("Quote"), hint: ">", keywords: ["quote", "引用"], style: "quote" },
];

export function filterSlashCommands(
  query: string,
  resolve: MessageResolver,
): ReadonlyArray<SlashCommand> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      resolve(command.label).toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}

const MARK_BUTTONS: ReadonlyArray<{ mark: NoteMarkName; label: string; icon: typeof BoldIcon }> = [
  { mark: "bold", label: msg("Bold"), icon: BoldIcon },
  { mark: "italic", label: msg("Italic"), icon: ItalicIcon },
  { mark: "strike", label: msg("Strikethrough"), icon: StrikethroughIcon },
  { mark: "code", label: msg("Inline code"), icon: CodeIcon },
];

interface BarState {
  readonly range: NoteRange;
  readonly rect: { top: number; bottom: number; left: number; width: number };
  /** With nothing selected, the bar shows only for a link the caret is in. */
  readonly link: { start: number; end: number; href: string } | null;
}

function readBarState(): BarState | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const anchor = selection.anchorNode;
  const element = (
    anchor instanceof Element ? anchor : anchor?.parentElement
  )?.closest<HTMLElement>("[data-note-text]");
  if (!element || document.activeElement !== element) return null;
  if (!selection.focusNode || !element.contains(selection.focusNode)) return null;
  const range = selectedRange(element);
  if (!range) return null;
  const link = linkRangeAt(range.date, range.nodeId, range.start);
  if (range.start === range.end && !link) return null;
  const box = selection.getRangeAt(0).getBoundingClientRect();
  const rect = box.width > 0 || box.height > 0 ? box : element.getBoundingClientRect();
  return {
    range,
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
    link: range.start === range.end ? link : null,
  };
}

/** Floats over selected note text with the inline formats, or over a link the caret is in. */
export function FormatBar(props: {
  readonly onEditLink: (range: NoteRange, href: string) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [state, setState] = useState<BarState | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the document selection and pointer, which live outside React
  useEffect(() => {
    const update = () => setState(pressed.current ? null : readBarState());
    const down = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      pressed.current = true;
      setState(null);
    };
    const up = () => {
      if (!pressed.current) return;
      pressed.current = false;
      setTimeout(update, 0);
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("scroll", update, true);
    };
  }, []);

  if (!state) return null;
  const { range, rect, link } = state;
  const node = locate(readDayTree(range.date) ?? [], range.nodeId)?.node;
  const below = rect.top < 72;
  const keepSelection = (event: ReactPointerEvent) => event.preventDefault();

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={link ? gt("Link") : gt("Format text")}
      className="fixed z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md"
      style={{
        left: Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8),
        top: below ? rect.bottom + 6 : rect.top - 6,
        transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
      onPointerDown={keepSelection}
    >
      {link ? (
        <>
          <span className="max-w-56 truncate px-2 text-xs text-muted-foreground">{link.href}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Open link")}
            onClick={() => openNoteLink(link.href)}
          >
            <ExternalLinkIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Edit link")}
            onClick={() =>
              props.onEditLink({ ...range, start: link.start, end: link.end }, link.href)
            }
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Remove link")}
            onClick={() => setRangeLink({ ...range, start: link.start, end: link.end }, null)}
          >
            <UnlinkIcon />
          </Button>
        </>
      ) : (
        <>
          {MARK_BUTTONS.map(({ mark, label, icon: Icon }) => {
            const active = node ? rangeHasMark(node.segments, range.start, range.end, mark) : false;
            return (
              <Button
                key={mark}
                size="icon-xs"
                variant={active ? "secondary" : "ghost"}
                aria-label={messages(label)}
                aria-pressed={active}
                onClick={() => toggleRangeMark(range, mark)}
              >
                <Icon />
              </Button>
            );
          })}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Link")}
            onClick={() => {
              const existing = linkRangeAt(range.date, range.nodeId, range.start);
              props.onEditLink(range, existing && range.end <= existing.end ? existing.href : "");
            }}
          >
            <LinkIcon />
          </Button>
        </>
      )}
    </div>
  );
}

/** Asks for a link address for a range of a note. */
export function LinkEditor(props: {
  readonly range: NoteRange;
  readonly href: string;
  readonly anchor: { top: number; bottom: number; left: number };
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [value, setValue] = useState(props.href);
  const href = normalizeHref(value);
  const close = (refocus: boolean) => {
    props.onClose();
    if (refocus)
      requestFocus(props.range.date, props.range.nodeId, props.range.start, props.range.end);
  };
  const apply = () => {
    if (!href) return;
    setRangeLink(props.range, href);
    props.onClose();
  };
  return (
    <div
      role="dialog"
      aria-label={gt("Link")}
      className="fixed z-50 flex w-80 items-center gap-1 rounded-lg border bg-popover p-1 shadow-lg"
      style={{
        left: Math.min(Math.max(8, props.anchor.left), window.innerWidth - 328),
        top: Math.min(props.anchor.bottom + 6, window.innerHeight - 52),
      }}
    >
      <Input
        autoFocus
        size="sm"
        aria-label={gt("Link address")}
        placeholder={gt("Paste or type a link")}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            apply();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close(true);
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node))
            close(false);
        }}
      />
      <Button size="xs" disabled={!href} onClick={apply}>
        <T>Apply</T>
      </Button>
      {props.href ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Remove link")}
          onClick={() => {
            setRangeLink(props.range, null);
            props.onClose();
          }}
        >
          <UnlinkIcon />
        </Button>
      ) : null}
    </div>
  );
}
