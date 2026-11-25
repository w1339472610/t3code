import { type DailyNoteError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DailyNotes from "../../../dailyNotes/DailyNotes.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { DailyNotesToolkit } from "./tools.ts";

const toFailure = (error: DailyNoteError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(DailyNotesToolkit, {
  daily_notes_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const notes = yield* DailyNotes.DailyNotes;
      return yield* notes.browse(input).pipe(Effect.mapError(toFailure));
    }),
  ),
  daily_notes_edit: McpToolAccess.writes(
    (input) =>
      DailyNotes.DailyNotes.pipe(
        Effect.flatMap((notes) => notes.edit(input)),
        Effect.mapError(toFailure),
      ),
    { refusedToLinked: "edit this environment's daily notes" },
  ),
});
