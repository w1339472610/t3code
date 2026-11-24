import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { createContext, useContext } from "react";

import { m } from "~/i18n/messages";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import type { NoteThreadSegment } from "./noteModel";

export type NoteThreadStatus =
  | "attention"
  | "working"
  | "snoozed"
  | "failed"
  | "unread"
  | "done"
  | "idle"
  | "missing";

export interface NoteThreadInfo {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: NoteThreadStatus;
  readonly activityAt: string;
}

export function noteThreadKey(environmentId: string, threadId: string): string {
  return scopedThreadKey(scopeThreadRef(environmentId as EnvironmentId, threadId as ThreadId));
}

/** The same signals the sidebar shows, folded into one icon. */
function noteThreadStatus(thread: EnvironmentThreadShell, now: number): NoteThreadStatus {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "request") return "attention";
  if (status === "working" || status === "preparing") return "working";
  if (status === "failed" || status === "limited") return "failed";
  if (thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now) return "snoozed";
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, undefined);
  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) return "unread";
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.settledAt !== null && thread.settledOverride !== "active")
  ) {
    return "done";
  }
  return "idle";
}

export function buildNoteThreadIndex(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: number,
  untitled: string,
): Map<string, NoteThreadInfo> {
  const index = new Map<string, NoteThreadInfo>();
  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    index.set(noteThreadKey(thread.environmentId, thread.id), {
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title.trim() || untitled,
      status: noteThreadStatus(thread, now),
      activityAt: thread.latestUserMessageAt ?? thread.updatedAt,
    });
  }
  return index;
}

export const NoteThreadIndexContext = createContext<ReadonlyMap<string, NoteThreadInfo>>(new Map());

export function useNoteThreadIndex() {
  return useContext(NoteThreadIndexContext);
}

export function resolveMention(
  index: ReadonlyMap<string, NoteThreadInfo>,
  segment: NoteThreadSegment,
): { title: string; status: NoteThreadStatus } {
  const info = index.get(noteThreadKey(segment.environmentId, segment.threadId));
  return info
    ? { title: info.title, status: info.status }
    : { title: segment.title, status: "missing" };
}

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

const STATUS_ICON: Record<NoteThreadStatus, string> = {
  attention:
    '<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  working:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  snoozed: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  failed: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  unread: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  idle: '<circle cx="12" cy="12" r="9" stroke-dasharray="3.4 3"/>',
  missing: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
};

const STATUS_LABEL = {
  attention: msg("Needs you"),
  working: msg("Working"),
  snoozed: msg("Snoozed"),
  failed: msg("Failed"),
  unread: msg("Unread"),
  done: msg("Done"),
  idle: msg("Idle"),
  missing: msg("Thread deleted or unavailable"),
} satisfies Record<NoteThreadStatus, string>;

/** A `msg()` descriptor; resolve it with `useMessages()` in render. */
export function noteThreadStatusMessage(status: NoteThreadStatus): string {
  return STATUS_LABEL[status];
}

const MENTION_CLASS =
  "dn-mention mx-px inline-flex max-w-full cursor-pointer items-baseline gap-1 rounded-sm align-baseline text-link select-none hover:underline data-[status=done]:text-muted-foreground data-[status=done]:line-through data-[status=missing]:text-muted-foreground data-[status=missing]:no-underline data-[selected=true]:bg-primary/15";

const STATUS_COLOR: Record<NoteThreadStatus, string> = {
  attention: "text-warning-foreground",
  working: "text-info-foreground",
  snoozed: "text-info-foreground",
  failed: "text-error-foreground",
  unread: "text-info-foreground",
  done: "text-muted-foreground",
  idle: "text-info-foreground",
  missing: "text-muted-foreground",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/** Mentions sit inside contenteditable text, so they are painted as plain DOM, not React. */
export function paintMention(
  element: HTMLElement,
  resolved: { title: string; status: NoteThreadStatus },
) {
  const label = m(STATUS_LABEL[resolved.status]);
  const shown =
    resolved.status === "missing" ? m(msg("Thread deleted or unavailable")) : resolved.title;
  const signature = `${resolved.status}\u0000${resolved.title}\u0000${label}\u0000${shown}`;
  if (element.dataset.painted === signature) return;
  element.dataset.painted = signature;
  element.dataset.status = resolved.status;
  element.title = `${shown} · ${label}`;
  element.innerHTML = `<span class="inline-flex size-3 shrink-0 self-center ${STATUS_COLOR[resolved.status]}">${SVG_OPEN}${STATUS_ICON[resolved.status]}</svg></span><span class="truncate">${escapeHtml(shown)}</span>`;
}

export function createMentionElement(segment: NoteThreadSegment): HTMLElement {
  const element = document.createElement("span");
  element.contentEditable = "false";
  element.className = MENTION_CLASS;
  element.dataset.mention = "thread";
  element.dataset.environmentId = segment.environmentId;
  element.dataset.threadId = segment.threadId;
  element.dataset.title = segment.title;
  return element;
}
