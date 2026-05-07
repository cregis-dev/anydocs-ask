/**
 * ISO 8601 week-of-year — used to slice runs/<YYYY-Www>.jsonl files.
 *
 * Algorithm (canonical):
 *   1. Take a UTC copy of the date.
 *   2. Move to the Thursday of the same ISO week (ISO weeks are Mon-Sun;
 *      the ISO week-year is determined by which year the Thursday is in).
 *   3. The week number = floor((thursday - jan 4 same-iso-year) / 7) + 1.
 *
 * Output format: `YYYY-Www` (zero-padded week, e.g. "2026-W19", "2026-W03").
 * The YYYY part is the ISO week-year, NOT necessarily the calendar year of
 * the input date — for dates near year boundaries the two can disagree
 * (e.g. 2026-01-01 is in ISO week 2026-W01 but 2025-12-29 is also W01).
 */

export function toIsoWeek(d: Date): string {
  // Copy and move to UTC midnight to avoid local-tz drift.
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: Mon=1 ... Sun=7. JS getUTCDay(): Sun=0..Sat=6.
  const isoWeekday = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  // Move to Thursday of this ISO week.
  utc.setUTCDate(utc.getUTCDate() + 4 - isoWeekday);
  const isoYear = utc.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  // First Thursday of the ISO year (anchor).
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() + 4 - jan4Weekday);
  const diffMs = utc.getTime() - firstThursday.getTime();
  const weekNum = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}
