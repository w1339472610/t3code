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
});
export type DailyNoteWriteInput = typeof DailyNoteWriteInput.Type;

export class DailyNoteError extends Schema.TaggedError<DailyNoteError>()("DailyNoteError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
