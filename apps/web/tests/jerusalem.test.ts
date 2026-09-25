import { describe, expect, it } from 'vitest';
import { addDays, jerusalemDate, jerusalemInstant } from '@/lib/shared/time/jerusalem';

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
