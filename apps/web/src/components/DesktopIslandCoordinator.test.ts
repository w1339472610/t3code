import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import {
  deriveIslandItem,
  ISLAND_DONE_VISIBLE_MS,
  ISLAND_FAILURE_VISIBLE_MS,
  islandRequest,
  lastFinishedItem,
  orderIslandItems,
} from "./DesktopIslandCoordinator";

const NOW = Date.parse("2026-03-09T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const run = (status: "completed" | "failed", completedMsAgo: number | null) =>
  ({
    runId: "run-1" as never,
    status,
    assistantMessageId: null,
    requestedAt: at(60 * 60_000),
    startedAt: at(60 * 60_000),
    completedAt: completedMsAgo === null ? null : at(completedMsAgo),
  }) satisfies NonNullable<Thread["latestRun"]>;

const runtime = (
  status: "running" | "completed" | "failed",
  lastErrorClass: "usage_limit" | null = null,
  lastError: string | null = null,
) => ({
  status,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: status === "running" ? ("run-1" as never) : null,
  activityStartedAt: status === "running" ? at(90_000) : null,
  lastError,
  lastErrorClass,
  usageLimitResetAt: lastErrorClass === "usage_limit" ? "2026-03-09T15:30:00" : null,
  updatedAt: at(0),
});

describe("deriveIslandItem", () => {
  it.each([
    [
      "working",
      { runtime: runtime("running") },
      { status: "working", since: NOW - 90_000, canStop: true },
    ],
    ["approval", { hasPendingApprovals: true }, { status: "approval" }],
    ["input", { hasPendingUserInput: true }, { status: "input" }],
    [
      "unseen completion",
      {
        runtime: runtime("completed"),
        latestRun: run("completed", 60_000),
        lastVisitedAt: at(5 * 60_000),
      },
      { status: "done", since: NOW - 60_000 },
    ],
    [
      "never-opened completion",
      { runtime: runtime("completed"), latestRun: run("completed", 60_000), lastVisitedAt: null },
      { status: "done" },
    ],
    [
      "seen completion",
      { runtime: runtime("completed"), latestRun: run("completed", 60_000), lastVisitedAt: at(0) },
      null,
    ],
    [
      "stale completion",
      {
        runtime: runtime("completed"),
        latestRun: run("completed", ISLAND_DONE_VISIBLE_MS + 1),
        lastVisitedAt: null,
      },
      null,
    ],
    [
      "unseen failure",
      {
        runtime: runtime("failed", null, "Provider exited\nstack trace"),
        latestRun: run("failed", 60_000),
        lastVisitedAt: null,
      },
      { status: "failed", detail: "Provider exited", canStop: false },
    ],
    [
      "usage limit",
      {
        runtime: runtime("failed", "usage_limit"),
        latestRun: run("failed", 60_000),
        lastVisitedAt: null,
      },
      { status: "limited", detail: "Resets at 15:30" },
    ],
    [
      "seen failure",
      { runtime: runtime("failed"), latestRun: run("failed", 60_000), lastVisitedAt: at(0) },
      null,
    ],
    [
      "stale failure",
      {
        runtime: runtime("failed"),
        latestRun: run("failed", ISLAND_FAILURE_VISIBLE_MS + 1),
        lastVisitedAt: null,
      },
      null,
    ],
    ["archived", { runtime: runtime("running"), archivedAt: at(0) }, null],
    ["snoozed", { hasPendingApprovals: true, snoozedUntil: at(-60_000) }, null],
    ["idle", {}, null],
  ] as const)("%s", (_name, overrides, expected) => {
    const thread = makeThreadFixture({ title: "Fix login", ...overrides } as Partial<Thread>);
    const item = deriveIslandItem(thread, "web", NOW, {
      language: "en",
      doneVisibleMs: ISLAND_DONE_VISIBLE_MS,
      canOperate: true,
    });
    if (expected === null) expect(item).toBeNull();
    else expect(item).toMatchObject({ title: "Fix login", project: "web", ...expected });
  });
});

describe("deriveIslandItem keep time", () => {
  it("drops a finished thread once the chosen keep time has passed", () => {
    const thread = makeThreadFixture({
      runtime: runtime("completed"),
      latestRun: run("completed", 6 * 60_000),
      lastVisitedAt: null,
    } as Partial<Thread>);
    const derive = (minutes: number) =>
      deriveIslandItem(thread, null, NOW, {
        language: "en",
        doneVisibleMs: minutes * 60_000,
        canOperate: true,
      });
    expect(derive(5)).toBeNull();
    expect(derive(15)).toMatchObject({ status: "done" });
  });
});

describe("orderIslandItems", () => {
  it("puts what needs the user first, then failures, work, and news, newest first", () => {
    const item = (
      threadId: string,
      status: "approval" | "failed" | "working" | "done",
      since: number,
    ) => ({
      environmentId: "env",
      threadId,
      title: threadId,
      project: null,
      status,
      since,
      detail: null,
      request: null,
      canStop: false,
    });
    const ordered = orderIslandItems([
      item("done", "done", 5),
      item("old-work", "working", 1),
      item("new-work", "working", 9),
      item("failed", "failed", 2),
      item("approval", "approval", 0),
    ]);
    expect(ordered.map((entry) => entry.threadId)).toEqual([
      "approval",
      "failed",
      "new-work",
      "old-work",
      "done",
    ]);
  });
});

describe("islandRequest", () => {
  const approval = (
    overrides: Partial<PendingThreadRequests["approvals"][number]> = {},
  ): PendingThreadRequests["approvals"][number] => ({
    requestId: "req-1" as never,
    requestKind: "command",
    createdAt: at(0),
    detail: "pnpm test",
    responseCapability: "live",
    ...overrides,
  });
  const input = (
    question: Partial<PendingThreadRequests["userInputs"][number]["questions"][number]>,
    extraQuestions = 0,
  ): PendingThreadRequests["userInputs"][number] => {
    const base = {
      id: "q1",
      header: "Music",
      question: "Which track?",
      options: [
        { label: "Calm", description: "Slow" },
        { label: "Upbeat", description: "Fast", value: "upbeat" },
      ],
      multiSelect: false,
      ...question,
    };
    return {
      requestId: "req-2" as never,
      createdAt: at(0),
      questions: Array.from({ length: 1 + extraQuestions }, (_, index) => ({
        ...base,
        id: `q${index + 1}`,
      })),
      responseCapability: "live",
      dismissible: false,
    };
  };
  const requests = (value: Partial<PendingThreadRequests>): PendingThreadRequests => ({
    approvals: [],
    userInputs: [],
    ...value,
  });

  it("offers the provider's decisions without cancel, the main yes last", () => {
    expect(
      islandRequest(
        "approval",
        requests({
          approvals: [
            approval({
              options: [
                { decision: "accept", label: "Yes" },
                { decision: "cancel", label: "Cancel" },
                { decision: "decline", label: "No" },
                { decision: "acceptAlways", label: "Always" },
              ],
            }),
          ],
        }),
      ),
    ).toEqual({
      kind: "approval",
      requestId: "req-1",
      action: "command",
      body: "pnpm test",
      decisions: ["decline", "acceptAlways", "accept"],
    });
  });

  it("falls back to the default decisions and skips requests a provider cannot take live", () => {
    expect(islandRequest("approval", requests({ approvals: [approval()] }))).toMatchObject({
      decisions: ["decline", "acceptForSession", "accept"],
    });
    expect(
      islandRequest(
        "approval",
        requests({ approvals: [approval({ responseCapability: "not_resumable" })] }),
      ),
    ).toBeNull();
  });

  it.each([
    ["one single-choice question", input({}), true],
    ["a multi-select question", input({ multiSelect: true }), false],
    ["a free-text question", input({ options: [] }), false],
    ["several questions", input({}, 1), false],
  ])("answers %s on the island only when one pick settles it", (_name, request, direct) => {
    expect(islandRequest("input", requests({ userInputs: [request] }))).toMatchObject({
      kind: "input",
      questionId: "q1",
      question: "Which track?",
      direct,
    });
  });

  it("sends an option's value, falling back to its label", () => {
    expect(islandRequest("input", requests({ userInputs: [input({})] }))).toMatchObject({
      options: [
        { label: "Calm", value: "Calm", description: "Slow" },
        { label: "Upbeat", value: "upbeat", description: "Fast" },
      ],
    });
  });
});

describe("lastFinishedItem", () => {
  it.each([
    [
      "an old, already opened completion",
      {
        runtime: runtime("completed"),
        latestRun: run("completed", 3 * 24 * 60 * 60_000),
        lastVisitedAt: at(0),
      },
      { status: "done", since: NOW - 3 * 24 * 60 * 60_000 },
    ],
    ["a failed run", { runtime: runtime("failed"), latestRun: run("failed", 60_000) }, null],
    ["a running thread", { runtime: runtime("running") }, null],
    [
      "an archived thread",
      { runtime: runtime("completed"), latestRun: run("completed", 60_000), archivedAt: at(0) },
      null,
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    const thread = makeThreadFixture({ title: "Cover", ...overrides } as Partial<Thread>);
    const item = lastFinishedItem(thread, "media");
    if (expected === null) expect(item).toBeNull();
    else expect(item).toMatchObject({ title: "Cover", project: "media", ...expected });
  });
});
