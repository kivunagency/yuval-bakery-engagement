import { describe, expect, it } from 'vitest';
import { weeklyPatternPut } from '@/lib/shared/contracts/capacity-pattern';

const week = (f: (w: number) => object = () => ({})) =>
  [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, isWorkingDay: w < 5, ovenMinutesTotal: 240, workMinutesTotal: 300, ...f(w) }));

describe('PUT /api/admin/capacity/pattern contract (client-007)', () => {
  it('accepts all seven weekdays once', () => {
    expect(weeklyPatternPut.safeParse({ days: week() }).success).toBe(true);
  });
  it('rejects six days, a repeated weekday, weekday 7, bad minutes and unknown keys', () => {
    expect(weeklyPatternPut.safeParse({ days: week().slice(0, 6) }).success).toBe(false);
    expect(weeklyPatternPut.safeParse({ days: week((w) => (w === 6 ? { weekday: 0 } : {})) }).success).toBe(false);
    expect(weeklyPatternPut.safeParse({ days: week((w) => (w === 6 ? { weekday: 7 } : {})) }).success).toBe(false);
    expect(weeklyPatternPut.safeParse({ days: week((w) => (w === 1 ? { ovenMinutesTotal: 2000 } : {})) }).success).toBe(false);
    expect(weeklyPatternPut.safeParse({ days: week((w) => (w === 1 ? { note: 'x' } : {})) }).success).toBe(false);
    expect(weeklyPatternPut.safeParse({ days: week(), extra: 1 }).success).toBe(false);
  });
});
