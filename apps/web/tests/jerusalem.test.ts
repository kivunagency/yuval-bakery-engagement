import { describe, expect, it } from 'vitest';
import { addDays, earliestDeliveryDate, jerusalemDate, jerusalemInstant } from '@/lib/shared/time/jerusalem';

describe('Asia/Jerusalem day boundaries', () => {
  it('23:30 UTC is already the next day in Jerusalem', () => {
    expect(jerusalemDate(new Date('2026-09-30T23:30:00Z'))).toBe('2026-10-01');
  });
  it('handles summer (UTC+3) and winter (UTC+2) offsets', () => {
    expect(jerusalemInstant('2026-07-01', '12:00').toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(jerusalemInstant('2026-12-01', '12:00').toISOString()).toBe('2026-12-01T10:00:00.000Z');
  });
  it('adds calendar days across a month end', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

// Same table as qa/db/business-day.test.mjs, which runs it against the DB rule.
describe('earliest delivery date (24h lead time, Asia/Jerusalem)', () => {
  const cases: [string, string, string][] = [
    ['2026-09-25T20:30:00Z', '2026-09-25', '2026-09-26'],
    ['2026-09-25T21:30:00Z', '2026-09-26', '2026-09-27'],
    ['2026-09-25T22:30:00Z', '2026-09-26', '2026-09-27'],
    ['2026-12-01T21:59:00Z', '2026-12-01', '2026-12-02'],
    ['2026-12-01T22:00:00Z', '2026-12-02', '2026-12-03'],
    ['2026-10-24T21:30:00Z', '2026-10-25', '2026-10-25'],
    ['2027-03-25T22:30:00Z', '2027-03-26', '2027-03-27'],
  ];
  it.each(cases)('at %s: business date %s, earliest delivery %s', (at, day, earliest) => {
    expect(jerusalemDate(new Date(at))).toBe(day);
    expect(earliestDeliveryDate(new Date(at))).toBe(earliest);
  });
});
