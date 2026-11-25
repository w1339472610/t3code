export type NotesViewMode = "day" | "week" | "month";

export function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

function addDays(key: string, days: number): string {
  const date = dateFromKey(key);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

/** Weeks start on Monday. */
export function startOfWeek(key: string): string {
  const offset = (dateFromKey(key).getDay() + 6) % 7;
  return addDays(key, -offset);
}

export function weekDays(key: string): string[] {
  const start = startOfWeek(key);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** Whole weeks covering the month of `key`, Monday first. */
export function monthGrid(key: string): string[] {
  const date = dateFromKey(key);
  const first = localDateKey(new Date(date.getFullYear(), date.getMonth(), 1));
  const last = localDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  const days: string[] = [];
  for (let day = startOfWeek(first); day <= last || days.length % 7 !== 0; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** The anchor date after stepping one day, week or month; months clamp to their last day. */
export function stepAnchor(key: string, mode: NotesViewMode, delta: -1 | 1): string {
  if (mode === "day") return addDays(key, delta);
  if (mode === "week") return addDays(key, 7 * delta);
  const date = dateFromKey(key);
  const target = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return localDateKey(target);
}

export function inView(key: string, anchor: string, mode: NotesViewMode): boolean {
  if (mode === "day") return key === anchor;
  if (mode === "week") return startOfWeek(key) === startOfWeek(anchor);
  return sameMonth(key, anchor);
}
