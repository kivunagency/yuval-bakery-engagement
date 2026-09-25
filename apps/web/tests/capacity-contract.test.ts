import { describe, expect, it } from 'vitest';
import { dayCapacityPatch, capacityDayParam, toAdminDayCapacity } from '@/lib/shared/contracts/capacity';

describe('PATCH /api/admin/capacity/[date] contract (api-009)', () => {
  it('accepts whole minutes 0..1440 and a blackout flag', () => {
    expect(dayCapacityPatch.parse({ ovenMinutesTotal: 0, workMinutesTotal: 1440, isBlackout: true })).toEqual({ ovenMinutesTotal: 0, workMinutesTotal: 1440, isBlackout: true });
  });
  it('rejects negatives, fractions, over a day, strings, missing and unknown keys', () => {
    const bad = [
      { ovenMinutesTotal: -1, workMinutesTotal: 1, isBlackout: false },
      { ovenMinutesTotal: 1.5, workMinutesTotal: 1, isBlackout: false },
      { ovenMinutesTotal: 1441, workMinutesTotal: 1, isBlackout: false },
      { ovenMinutesTotal: '10', workMinutesTotal: 1, isBlackout: false },
      { ovenMinutesTotal: 10, workMinutesTotal: 1 },
      { ovenMinutesTotal: 10, workMinutesTotal: 1, isBlackout: false, ovenMinutesReserved: 0 },
    ];
    for (const b of bad) expect(dayCapacityPatch.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
  it('date param must be a real calendar date', () => {
    expect(capacityDayParam.safeParse('2026-10-01').success).toBe(true);
    expect(capacityDayParam.safeParse('2026-02-30').success).toBe(false);
    expect(capacityDayParam.safeParse('pattern').success).toBe(false);
  });
  it('maps a ledger row to the camelCase response', () => {
    expect(
      toAdminDayCapacity({
        day: '2026-10-01', oven_minutes_total: 300, oven_minutes_reserved: 60, oven_minutes_unpaid_reserved: 20,
        work_minutes_total: 420, work_minutes_reserved: 90, work_minutes_unpaid_reserved: 30, is_blackout: false, source: 'manual',
      }),
    ).toEqual({
      day: '2026-10-01', ovenMinutesTotal: 300, ovenMinutesReserved: 60, ovenMinutesUnpaidReserved: 20,
      workMinutesTotal: 420, workMinutesReserved: 90, workMinutesUnpaidReserved: 30, isBlackout: false, source: 'manual',
    });
  });
});
