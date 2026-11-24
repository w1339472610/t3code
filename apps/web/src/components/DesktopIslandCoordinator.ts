// @effect-diagnostics globalTimers:off globalDate:off - Runs in atom subscriptions, outside an Effect runtime.
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import {
  AuthOrchestrationOperateScope,
  type DesktopIslandAction,
  type DesktopIslandItem,
  type DesktopIslandPrefs,
  type DesktopIslandRequest,
  type DesktopIslandSnapshot,
  type DesktopIslandStatus,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { AnyRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { msg } from "gt-react";
import { getActiveLocale, m } from "../i18n/messages";
import { subscribeI18n } from "../i18n/runtime";
import { environmentSummaries } from "../state/presentation";
import { readEnvironmentScope } from "../state/session";
import { environmentShell } from "../state/shell";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

/** The island page carries its own English and Chinese copy; it follows the app's language. */
type UiLanguage = "en" | "zh";
const readUiLanguage = (): UiLanguage => (getActiveLocale().startsWith("zh") ? "zh" : "en");

/** A finished thread stays on the island this long by default, unless it is opened first. */
export const ISLAND_DONE_VISIBLE_MS = 15 * 60_000;
/** An unseen failure stays longer: it is still waiting on the user. */
export const ISLAND_FAILURE_VISIBLE_MS = 12 * 60 * 60_000;
const ISLAND_MAX_ITEMS = 24;
const ISLAND_TEXT_MAX = 500;

const STATUS_RANK: Record<DesktopIslandStatus, number> = {
  approval: 0,
  input: 0,
  request: 0,
  failed: 1,
  limited: 1,
  working: 2,
  done: 3,
};

/** Read left to right on the island: the way out first, the main yes last. */
const DECISION_ORDER: Record<ProviderApprovalDecision, number> = {
  cancel: 0,
  decline: 1,
  acceptForSession: 2,
  acceptAlways: 3,
  accept: 4,
};
const DEFAULT_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = [
  "decline",
  "acceptForSession",
  "accept",
];

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function clip(value: string | null | undefined, max = ISLAND_TEXT_MAX): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Unopened threads count as unseen, unlike the sidebar's Done: the island is for news. */
function isUnseenSince(thread: EnvironmentThreadShell, at: number): boolean {
  const visited = parseTime(thread.lastVisitedAt);
  return visited === null || at > visited;
}

function failureDetail(
  thread: EnvironmentThreadShell,
  status: "failed" | "limited",
): string | null {
  if (status === "limited") {
    const resetAt = parseTime(thread.runtime?.usageLimitResetAt);
    if (resetAt === null) return null;
    const at = new Date(resetAt);
    const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
    return m(msg("Resets at {time}", { time }));
  }
  return clip(thread.runtime?.lastError?.split("\n")[0], 200);
}

export interface IslandItemOptions {
  readonly language: UiLanguage;
  readonly doneVisibleMs: number;
  /** The user may act on this environment's threads: stop, approve, answer. */
  readonly canOperate: boolean;
}

export function deriveIslandItem(
  thread: EnvironmentThreadShell,
  projectTitle: string | null,
  now: number,
  options: IslandItemOptions,
): DesktopIslandItem | null {
  if (thread.archivedAt !== null) return null;
  const snoozedUntil = parseTime(thread.snoozedUntil);
  if (snoozedUntil !== null && snoozedUntil > now) return null;
  const sidebarStatus = resolveSidebarThreadStatus(thread);
  const completedAt = parseTime(thread.latestRun?.completedAt);
  let status: DesktopIslandStatus;
  let since: number | null;
  switch (sidebarStatus) {
    case "approval":
    case "input":
    case "request":
      status = sidebarStatus;
      since =
        parseTime(thread.pendingUserInputAt) ?? parseTime(thread.updatedAt) ?? completedAt ?? null;
      break;
    case "preparing":
    case "working":
      status = "working";
      since = parseTime(resolveThreadWorkingStartedAt(thread));
      break;
    case "failed":
    case "limited": {
      const failedAt = completedAt ?? parseTime(thread.updatedAt);
      if (failedAt === null || now - failedAt > ISLAND_FAILURE_VISIBLE_MS) return null;
      if (!isUnseenSince(thread, failedAt)) return null;
      status = sidebarStatus;
      since = failedAt;
      break;
    }
    case "ready": {
      if (completedAt === null || now - completedAt > options.doneVisibleMs) return null;
      if (!isUnseenSince(thread, completedAt)) return null;
      if (thread.latestRun?.status === "failed") {
        status = "failed";
      } else if (thread.latestRun?.status === "completed") {
        status = "done";
      } else {
        return null;
      }
      since = completedAt;
      break;
    }
    default:
      return null;
  }
  return {
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: clip(thread.title) ?? "",
    project: clip(projectTitle),
    status,
    since,
    detail: status === "failed" || status === "limited" ? failureDetail(thread, status) : null,
    request: null,
    canStop: status === "working" && options.canOperate,
  };
}

/** A thread whose latest run finished, as the resting island shows it, however long ago. */
export function lastFinishedItem(
  thread: EnvironmentThreadShell,
  projectTitle: string | null,
): DesktopIslandItem | null {
  if (thread.archivedAt !== null || thread.latestRun?.status !== "completed") return null;
  const completedAt = parseTime(thread.latestRun.completedAt);
  if (completedAt === null) return null;
  return {
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: clip(thread.title) ?? "",
    project: clip(projectTitle),
    status: "done",
    since: completedAt,
    detail: null,
    request: null,
    canStop: false,
  };
}

/**
 * The part of a thread's pending request the island can answer. Requests a provider can no
 * longer take live, and questions that need typing or several picks, stay in T3.
 */
export function islandRequest(
  status: DesktopIslandStatus,
  requests: PendingThreadRequests | null,
): DesktopIslandRequest | null {
  if (requests === null) return null;
  if (status === "approval") {
    const approval = requests.approvals.find((entry) => entry.responseCapability === "live");
    if (!approval) return null;
    const offered = approval.options?.map((option) => option.decision) ?? DEFAULT_DECISIONS;
    return {
      kind: "approval",
      requestId: approval.requestId,
      action: approval.requestKind,
      body: clip(approval.detail ?? approval.appName ?? null),
      decisions: offered
        .filter((decision) => decision !== "cancel")
        .toSorted((left, right) => DECISION_ORDER[left] - DECISION_ORDER[right]),
    };
  }
  if (status === "input") {
    const input = requests.userInputs.find((entry) => entry.responseCapability === "live");
    const question = input?.questions[0];
    if (!input || !question) return null;
    const options = question.options
      .map((option) => ({
        label: clip(option.label, 120) ?? "",
        value: option.value ?? option.label,
        description: clip(option.description, 300),
      }))
      .filter((option) => option.value.length <= ISLAND_TEXT_MAX)
      .slice(0, 12);
    return {
      kind: "input",
      requestId: input.requestId,
      questionId: question.id,
      question: clip(question.question) ?? clip(question.header) ?? "",
      options,
      // An answer is sent verbatim, so an option whose value cannot travel cannot be picked here.
      direct:
        input.questions.length === 1 &&
        !question.multiSelect &&
        options.length > 0 &&
        options.length === question.options.length,
    };
  }
  return null;
}

/** What "only what needs me" keeps: threads waiting on the user, and failures. */
const ATTENTION: ReadonlySet<DesktopIslandStatus> = new Set([
  "approval",
  "input",
  "request",
  "failed",
  "limited",
]);

function islandPrefs(settings: ClientSettings): DesktopIslandPrefs {
  return {
    idleVisible: settings.desktopIslandIdleVisible,
    expandOn: settings.desktopIslandExpandOn,
    onFullScreen: settings.desktopIslandOnFullScreen,
    motion: settings.desktopIslandMotion,
  };
}

function compareIslandItems(left: DesktopIslandItem, right: DesktopIslandItem): number {
  return (
    STATUS_RANK[left.status] - STATUS_RANK[right.status] || (right.since ?? 0) - (left.since ?? 0)
  );
}

/** Most urgent first; within a status, the newest first. */
export function orderIslandItems(
  items: ReadonlyArray<DesktopIslandItem>,
): ReadonlyArray<DesktopIslandItem> {
  return items.toSorted(compareIslandItems).slice(0, ISLAND_MAX_ITEMS);
}

/** When the next item leaves the island by age alone. */
function nextExpiry(items: ReadonlyArray<DesktopIslandItem>, doneVisibleMs: number): number | null {
  let next: number | null = null;
  for (const item of items) {
    if (item.since === null) continue;
    const ttl =
      item.status === "done"
        ? doneVisibleMs
        : item.status === "failed" || item.status === "limited"
          ? ISLAND_FAILURE_VISIBLE_MS
          : null;
    if (ttl === null) continue;
    const at = item.since + ttl;
    if (next === null || at < next) next = at;
  }
  return next;
}

interface CachedThread {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
}

interface IslandEntry {
  readonly ref: ScopedThreadRef;
  readonly item: DesktopIslandItem;
}

interface WatchedEnvironment {
  entries: ReadonlyArray<IslandEntry>;
  /** This environment's most recently finished thread, whatever its age. */
  recent: IslandEntry | null;
  unsubscribe: () => void;
}

/** Keys what the island shows by plain strings, the form its actions come back in. */
const islandKey = (environmentId: string, threadId: string) => `${environmentId}\n${threadId}`;

interface RequestWatch {
  value: PendingThreadRequests | null;
  stop: () => void;
}

const canOperate = (environmentId: EnvironmentId) =>
  readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

/**
 * Feeds the macOS menu bar island: every connected environment's threads that are working,
 * waiting on the user, failed, or just finished, most urgent first. It also carries out what
 * the island asks for: opening a thread, answering its request, or stopping its run.
 */
export function startDesktopIsland(registry: AtomRegistry.AtomRegistry, router: AnyRouter): void {
  const bridge = window.desktopBridge;
  const setIsland = bridge?.setIsland;
  if (!bridge || !setIsland || bridge.getClientPlatform() !== "darwin") return;

  const watched = new Map<EnvironmentId, WatchedEnvironment>();
  // Only threads waiting on an approval or a question: their details load the thread, which
  // is idle while it waits, so the stream stays quiet.
  const requestWatches = new Map<string, RequestWatch>();
  let published = new Map<string, IslandEntry>();
  let lastSent: string | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;

  const send = (snapshot: DesktopIslandSnapshot | null) => {
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSent) return;
    lastSent = serialized;
    void setIsland(snapshot).catch(() => undefined);
  };

  const syncRequestWatches = (entries: ReadonlyArray<IslandEntry>) => {
    const wanted = new Map(
      entries
        .filter(({ item }) => item.status === "approval" || item.status === "input")
        .map((entry) => [threadKey(entry.ref), entry.ref] as const),
    );
    for (const [key, watch] of requestWatches) {
      if (wanted.has(key)) continue;
      watch.stop();
      requestWatches.delete(key);
    }
    for (const [key, ref] of wanted) {
      if (requestWatches.has(key)) continue;
      const watch: RequestWatch = { value: null, stop: () => {} };
      requestWatches.set(key, watch);
      watch.stop = registry.subscribe(
        environmentThreadDetails.pendingRequestsAtom(ref),
        (value) => {
          watch.value = value;
          schedulePublish();
        },
        { immediate: true },
      );
    }
  };

  const publish = () => {
    scheduled = false;
    clearTimeout(expiryTimer);
    if (!getClientSettings().desktopIslandEnabled) {
      syncRequestWatches([]);
      published = new Map();
      send(null);
      return;
    }
    const settings = getClientSettings();
    const entries = [...watched.values()]
      .flatMap((entry) => entry.entries)
      .filter(({ item }) => settings.desktopIslandScope === "all" || ATTENTION.has(item.status));
    syncRequestWatches(entries);
    const ordered = entries
      .map(({ ref, item }) => {
        const watch = requestWatches.get(threadKey(ref));
        const request =
          watch && canOperate(ref.environmentId) ? islandRequest(item.status, watch.value) : null;
        return { ref, item: request ? { ...item, request } : item };
      })
      .toSorted((left, right) => compareIslandItems(left.item, right.item))
      .slice(0, ISLAND_MAX_ITEMS);
    // A resting island shows the last thread to finish, so it can be opened from there too.
    const recent = settings.desktopIslandIdleVisible
      ? [...watched.values()].reduce<IslandEntry | null>(
          (latest, entry) =>
            entry.recent &&
            (latest === null || (entry.recent.item.since ?? 0) > (latest.item.since ?? 0))
              ? entry.recent
              : latest,
          null,
        )
      : null;
    published = new Map(
      [...ordered, ...(recent ? [recent] : [])].map((entry) => [
        islandKey(entry.ref.environmentId, entry.ref.threadId),
        entry,
      ]),
    );
    const items = ordered.map((entry) => entry.item);
    send({
      language: readUiLanguage(),
      prefs: islandPrefs(settings),
      items,
      recent: recent?.item ?? null,
    });
    const expiry = nextExpiry(items, settings.desktopIslandDoneMinutes * 60_000);
    if (expiry !== null) {
      expiryTimer = setTimeout(recomputeAll, Math.max(1_000, expiry - Date.now() + 500));
    }
  };
  // Several environments can update in one tick; send their combined state once.
  const schedulePublish = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(publish);
  };

  const recomputers = new Map<EnvironmentId, () => void>();
  const recomputeAll = () => {
    for (const recompute of recomputers.values()) recompute();
    schedulePublish();
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const cache = new Map<string, CachedThread>();
    const entry: WatchedEnvironment = { entries: [], recent: null, unsubscribe: () => {} };
    const recompute = () => {
      const shell = registry.get(environmentShell.stateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
        entry.entries = [];
        entry.recent = null;
        return;
      }
      const { threads, projects } = shell.snapshot.value;
      const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
      const subagentRequests = registry.get(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      );
      const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
      const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
      const now = Date.now();
      const options = {
        language: readUiLanguage(),
        doneVisibleMs: getClientSettings().desktopIslandDoneMinutes * 60_000,
        canOperate: canOperate(environmentId),
      };
      const entries: Array<IslandEntry> = [];
      let recent: IslandEntry | null = null;
      const seen = new Set<string>();
      for (const raw of threads) {
        const ref = { environmentId, threadId: raw.id };
        if (isShownUnderParent(ref, raw.lineage, delegatedUnderParent)) continue;
        const key = threadKey(ref);
        if (hidden.has(key)) continue;
        seen.add(key);
        const subagentRequest = subagentRequests.get(raw.id) ?? null;
        let cached = cache.get(key);
        if (!cached || cached.raw !== raw || cached.subagentRequest !== subagentRequest) {
          cached = {
            raw,
            subagentRequest,
            thread: presentThreadShell(environmentId, raw, subagentRequest),
          };
          cache.set(key, cached);
        }
        const projectTitle = projectTitles.get(cached.thread.projectId) ?? null;
        const item = deriveIslandItem(cached.thread, projectTitle, now, options);
        if (item) entries.push({ ref, item });
        const finished = lastFinishedItem(cached.thread, projectTitle);
        if (finished && (recent === null || (finished.since ?? 0) > (recent.item.since ?? 0))) {
          recent = { ref, item: finished };
        }
      }
      for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
      entry.entries = entries;
      entry.recent = recent;
    };
    recomputers.set(environmentId, recompute);
    const onChange = () => {
      recompute();
      schedulePublish();
    };
    const stops = [
      registry.subscribe(environmentShell.stateValueAtom(environmentId), onChange, {
        immediate: true,
      }),
      registry.subscribe(
        environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
        onChange,
      ),
    ];
    entry.unsubscribe = () => {
      recomputers.delete(environmentId);
      for (const stop of stops) stop();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const environmentIds = getClientSettings().desktopIslandEnabled
      ? registry.get(environmentSummaries.environmentIdsAtom)
      : [];
    const active = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (active.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
    // The language shapes some lines, such as when a usage limit resets.
    recomputeAll();
  };

  /** Acts only on what the island was last shown, with ids taken from this side's state. */
  const handleAction = (action: DesktopIslandAction) => {
    if (action.type === "settings") {
      void router.navigate({ to: "/settings/general", hash: "menu-bar-island" });
      return;
    }
    const entry = published.get(islandKey(action.environmentId, action.threadId));
    if (!entry) return;
    const { environmentId, threadId } = entry.ref;
    if (action.type === "open") {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
      return;
    }
    if (!canOperate(environmentId)) return;
    const requests = requestWatches.get(threadKey(entry.ref))?.value ?? null;
    if (action.type === "approve") {
      const approval = requests?.approvals.find((entry) => entry.requestId === action.requestId);
      if (!approval) return;
      void runAtomCommand(registry, threadEnvironment.respondToApproval, {
        environmentId,
        input: { threadId, requestId: approval.requestId, decision: action.decision },
      });
      return;
    }
    if (action.type === "answer") {
      const input = requests?.userInputs.find((entry) => entry.requestId === action.requestId);
      const question = input?.questions.find((entry) => entry.id === action.questionId);
      const offered = question?.options.some(
        (option) => (option.value ?? option.label) === action.answer,
      );
      if (!input || !question || !offered) return;
      void runAtomCommand(registry, threadEnvironment.respondToUserInput, {
        environmentId,
        input: { threadId, requestId: input.requestId, answers: { [question.id]: action.answer } },
      });
      return;
    }
    if (entry.item.status !== "working") return;
    void runAtomCommand(registry, threadEnvironment.interruptTurn, {
      environmentId,
      input: { threadId },
    });
  };

  subscribeClientSettings(syncEnvironments);
  subscribeI18n(recomputeAll);
  registry.subscribe(environmentSummaries.environmentIdsAtom, syncEnvironments);
  registry.subscribe(environmentThreadShells.delegatedUnderParentAtom, recomputeAll);
  registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, recomputeAll);
  bridge.onIslandAction?.(handleAction);
  syncEnvironments();
}
