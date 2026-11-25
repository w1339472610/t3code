import * as Schema from "effect/Schema";

/**
 * Daily notes are one Markdown outline per local day, `<notes folder>/YYYY-MM-DD.md`, kept by
 * the primary environment. The folder defaults to `<T3 home>/notes`.
 */
export const DailyNoteDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type DailyNoteDate = typeof DailyNoteDate.Type;

export const DAILY_NOTE_MAX_CHARS = 2 * 1024 * 1024;

export const DailyNoteDay = Schema.Struct({
  date: DailyNoteDate,
  /** The file's mtime, ISO. */
  updatedAt: Schema.String,
});
export type DailyNoteDay = typeof DailyNoteDay.Type;

export const DailyNotesSnapshot = Schema.Struct({
  directory: Schema.String,
  /** Days whose file has content, newest first. */
  days: Schema.Array(DailyNoteDay),
});
export type DailyNotesSnapshot = typeof DailyNotesSnapshot.Type;

export const DailyNoteReadInput = Schema.Struct({ date: DailyNoteDate });
export type DailyNoteReadInput = typeof DailyNoteReadInput.Type;

export const DailyNote = Schema.Struct({
  date: DailyNoteDate,
  content: Schema.String,
  /** Null when the day has no file. */
  updatedAt: Schema.NullOr(Schema.String),
});
export type DailyNote = typeof DailyNote.Type;

/** Replaces the day's file; blank content removes it. */
export const DailyNoteWriteInput = Schema.Struct({
  date: DailyNoteDate,
  content: Schema.String.check(Schema.isMaxLength(DAILY_NOTE_MAX_CHARS)),
  /**
   * The content this write was edited from. When the file changed since, the
   * write is merged with that change instead of replacing it; the reply holds the result.
   */
  base: Schema.optional(Schema.String.check(Schema.isMaxLength(DAILY_NOTE_MAX_CHARS))),
});
export type DailyNoteWriteInput = typeof DailyNoteWriteInput.Type;

/** One day as an agent sees it; `version` changes whenever the content does. */
export const DailyNoteVersioned = Schema.Struct({
  date: DailyNoteDate,
  version: Schema.String,
  content: Schema.String,
});
export type DailyNoteVersioned = typeof DailyNoteVersioned.Type;

export const DailyNotesBrowseInput = Schema.Struct({
  date: Schema.optional(DailyNoteDate),
  from: Schema.optional(DailyNoteDate),
  to: Schema.optional(DailyNoteDate),
  query: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
export type DailyNotesBrowseInput = typeof DailyNotesBrowseInput.Type;

export const DailyNotesBrowseResult = Schema.Struct({
  folder: Schema.String,
  today: DailyNoteDate,
  days: Schema.Array(DailyNoteVersioned),
  /** Days with notes that did not fit, newest first. */
  moreDates: Schema.Array(DailyNoteDate),
  matches: Schema.optional(
    Schema.Array(Schema.Struct({ date: DailyNoteDate, line: Schema.Number, text: Schema.String })),
  ),
});
export type DailyNotesBrowseResult = typeof DailyNotesBrowseResult.Type;

const NoteText = Schema.String.check(Schema.isMaxLength(DAILY_NOTE_MAX_CHARS));

export const DailyNoteEditInput = Schema.Struct({
  date: DailyNoteDate,
  edits: Schema.optional(
    Schema.Array(
      Schema.Struct({ oldText: NoteText.check(Schema.isMinLength(1)), newText: NoteText }),
    ),
  ),
  append: Schema.optional(NoteText),
  content: Schema.optional(NoteText),
  version: Schema.optional(Schema.String),
});
export type DailyNoteEditInput = typeof DailyNoteEditInput.Type;

export class DailyNoteError extends Schema.TaggedError<DailyNoteError>()("DailyNoteError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
