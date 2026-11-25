import {
  DailyNoteEditInput,
  DailyNoteVersioned,
  DailyNotesBrowseInput,
  DailyNotesBrowseResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as DailyNotes from "../../../dailyNotes/DailyNotes.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    DailyNotes.DailyNotes,
  ],
};

const DailyNotesReadTool = Tool.make("daily_notes_read", {
  ...shared,
  description:
    "Read the user's daily notes (每日笔记): one Markdown outline per local day, the user's plans, to-dos and work log. No arguments: today and recent days, newest first; `moreDates` lists the rest. `date`, or `from`/`to` (YYYY-MM-DD), picks days. `query` searches every day and returns matching lines.",
  parameters: Schema.Struct(DailyNotesBrowseInput.fields),
  success: DailyNotesBrowseResult,
})
  .annotate(Tool.Title, "Read daily notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DailyNotesEditTool = Tool.make("daily_notes_edit", {
  ...shared,
  description:
    "Edit one day of the user's daily notes like a document; their open notes update live. `edits`: exact `oldText` → `newText`, each oldText found once in the day as you read it. `append`: lines added at the end. `content`: the whole day, with the `version` you read (none for an empty day). Format: `- ` items, children indented 2 spaces (3 under `1. `), `- [ ] `/`- [x] ` to-dos, `- # ` to `- ### ` headings, `- > ` quotes, `1. ` numbered, **bold** _italic_ ~~strike~~ `code` [text](url). Keep `[@title](t3://thread/…)` thread mentions and `<!-- collapsed -->` as they are.",
  parameters: Schema.Struct(DailyNoteEditInput.fields),
  success: DailyNoteVersioned,
})
  .annotate(Tool.Title, "Edit daily notes")
  .annotate(Tool.Destructive, true);

export const DailyNotesToolkit = Toolkit.make(DailyNotesReadTool, DailyNotesEditTool);
