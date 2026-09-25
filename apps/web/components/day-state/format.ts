// Calendar helpers for a YYYY-MM-DD day (already an Asia/Jerusalem date, so
// no time zone math here: the weekday of a calendar date is fixed).

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export function weekdayKey(isoDay: string): WeekdayKey {
  return WEEKDAY_KEYS[new Date(`${isoDay}T12:00:00Z`).getUTCDay()]!;
}

export function dayOfMonth(isoDay: string): number {
  return Number(isoDay.slice(8, 10));
}

/** Israeli short date: day.month, no leading zeros ("1.10"). */
export function shortDate(isoDay: string): string {
  return `${Number(isoDay.slice(8, 10))}.${Number(isoDay.slice(5, 7))}`;
}

/**
 * shortDate wrapped in LEFT-TO-RIGHT ISOLATE ... POP DIRECTIONAL ISOLATE, for
 * use inside running Hebrew text: punctuation after the date ("28.9,")
 * then follows the Hebrew paragraph instead of joining the number's run.
 */
export function isolatedDate(isoDay: string): string {
  return `⁦${shortDate(isoDay)}⁩`;
}
