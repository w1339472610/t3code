import type { DailyNoteDate } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";
import { useQuietThreadShells } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  applyServerSnapshot,
  editDayWhenLoaded,
  flushDailyNotes,
  setDailyNotesIo,
} from "./dailyNotesStore";
import {
  makeNode,
  type NoteNode,
  type NoteThreadSegment,
  normalizeSegments,
  segmentsKey,
  updateNode,
} from "./noteModel";
import { noteThreadKey } from "./noteThreads";

/** A node turned into a thread draft; it becomes a mention once the thread is created. */
export interface PendingConversion {
  readonly date: string;
  readonly segmentsKey: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: number;
}

const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Effects can run twice before the finished entry leaves the store; a thread converts once. */
const completing = new Set<string>();

const usePendingConversions = create<{ readonly pending: ReadonlyArray<PendingConversion> }>()(
  persist(() => ({ pending: [] as ReadonlyArray<PendingConversion> }), {
    name: "t3code:daily-notes:pending-conversions",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

export function addPendingConversion(input: Omit<PendingConversion, "createdAt">) {
  const conversion: PendingConversion = { ...input, createdAt: Date.now() };
  usePendingConversions.setState((state) => ({
    pending: [
      ...state.pending.filter(
        (entry) =>
          entry.threadId !== conversion.threadId && Date.now() - entry.createdAt < PENDING_TTL_MS,
      ),
      conversion,
    ],
  }));
}

function findBySegments(nodes: ReadonlyArray<NoteNode>, key: string): NoteNode | null {
  for (const node of nodes) {
    if (segmentsKey(node.segments) === key) return node;
    const found = findBySegments(node.children, key);
    if (found) return found;
  }
  return null;
}

async function completeConversion(conversion: PendingConversion, title: string) {
  const mention: NoteThreadSegment = {
    kind: "thread",
    environmentId: conversion.environmentId,
    threadId: conversion.threadId,
    title,
  };
  await editDayWhenLoaded(conversion.date, (tree) => {
    const node = findBySegments(tree, conversion.segmentsKey);
    if (node) {
      return updateNode(tree, node.id, (current) => ({
        ...current,
        segments: [mention],
        collapsed: current.children.length > 0,
      }));
    }
    // The text changed meanwhile; keep it and add the mention at the end of the day.
    return [...tree, makeNode({ segments: normalizeSegments([mention]) })];
  });
}

/** Lives with the app shell: keeps notes readable and writable, and finishes conversions. */
export function DailyNotesBackground() {
  const environmentId = usePrimaryEnvironmentId();
  const read = useAtomCommand(serverEnvironment.readDailyNote, {
    label: "daily note read",
    reportFailure: false,
  });
  const write = useAtomCommand(serverEnvironment.writeDailyNote, { label: "daily note save" });
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.dailyNotesLive({ environmentId, input: {} }),
  ).data;
  const pending = usePendingConversions((state) => state.pending);
  const threads = useQuietThreadShells();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the module-level notes store a way to reach the server for the current environment
  useEffect(() => {
    if (environmentId === null) {
      setDailyNotesIo(null);
      return;
    }
    setDailyNotesIo({
      read: async (date: DailyNoteDate) => {
        const result = await read({ environmentId, input: { date } });
        return result._tag === "Success" ? result.value : null;
      },
      write: async (date: DailyNoteDate, content: string) => {
        const result = await write({ environmentId, input: { date, content } });
        return result._tag === "Success" ? result.value : null;
      },
    });
    const flush = () => flushDailyNotes();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flushDailyNotes();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the command callbacks are recreated every render; the environment is what matters
  }, [environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads open days when their files change outside this client
  useEffect(() => {
    if (snapshot) applyServerSnapshot(snapshot);
  }, [snapshot]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rewrites a converted note once its thread exists on the server
  useEffect(() => {
    if (pending.length === 0) return;
    const byKey = new Map(
      threads.map((thread) => [noteThreadKey(thread.environmentId, thread.id), thread]),
    );
    const done: PendingConversion[] = [];
    for (const conversion of pending) {
      const thread = byKey.get(noteThreadKey(conversion.environmentId, conversion.threadId));
      if (thread && thread.deletedAt === null) {
        done.push(conversion);
        if (completing.has(conversion.threadId)) continue;
        completing.add(conversion.threadId);
        void completeConversion(conversion, thread.title.trim() || conversion.title);
      } else if (Date.now() - conversion.createdAt > PENDING_TTL_MS) {
        done.push(conversion);
      }
    }
    if (done.length > 0) {
      usePendingConversions.setState((state) => ({
        pending: state.pending.filter((entry) => !done.includes(entry)),
      }));
    }
  }, [pending, threads]);

  return null;
}
