// Day boundaries and lead time are Asia/Jerusalem (Ran, 2026-09-25), on the
// server and in the DB, whatever the server's own clock zone is.
export const BUSINESS_TZ = 'Asia/Jerusalem';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The calendar date (YYYY-MM-DD) in Jerusalem at the given instant. */
export function jerusalemDate(at: Date): string {
  return dateFmt.format(at);
}

/**
 * First delivery date allowed for an order placed at `now`: the Jerusalem
 * date 24 real hours later (BRIEF: minimum 24 hours, Asia/Jerusalem). Same
 * rule as fn_earliest_delivery_date in the DB, which enforces it; this copy is
 * for the day picker. A delivery on this date at an hour less than 24 hours
 * away still needs the time-window check at checkout (ADR-002).
 */
export function earliestDeliveryDate(now: Date): string {
  return jerusalemDate(new Date(now.getTime() + 24 * 3600 * 1000));
}

/** Add whole calendar days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant of a Jerusalem wall-clock time on a date, DST-aware.
 * Example: jerusalemInstant('2026-10-01', '12:00').
 */
export function jerusalemInstant(isoDate: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)), h, m);
  // Offset of Jerusalem at that moment: format the guess back and compare.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asUtc - guess));
}

/** Lead time (BRIEF, final): hours before the start of the chosen slot. */
export const LEAD_TIME_HOURS = 24;

/**
 * True when a slot starting at `hhmm` (Jerusalem wall clock) on `isoDate` is
 * at least `leadHours` real hours after `now`. Same rule as
 * fn_slot_meets_lead_time in the DB, which enforces it at order insert
 * (trg_orders_lead_time); parity is tested on the shared cases in
 * qa/db/slot-lead-time.cases.json. This copy only greys out slots on screen.
 */
export function slotMeetsLeadTime(isoDate: string, hhmm: string, now: Date, leadHours: number = LEAD_TIME_HOURS): boolean {
  return jerusalemInstant(isoDate, hhmm).getTime() >= now.getTime() + leadHours * 3600 * 1000;
}

const hhmmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** HH:MM in Jerusalem at the given instant. */
export function jerusalemHhmm(at: Date): string {
  return hhmmFmt.format(at);
}
