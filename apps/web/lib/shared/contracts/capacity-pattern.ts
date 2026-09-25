import { z } from 'zod';
import { minutes } from '@/lib/shared/contracts/primitives';

// Standing weekly pattern (client-007, PRD section 4). weekday 0 = Sunday,
// the same numbering as Postgres EXTRACT(DOW) and Date.getUTCDay().

export const patternDay = z
  .object({
    weekday: z.number().int().min(0).max(6),
    isWorkingDay: z.boolean(),
    ovenMinutesTotal: minutes,
    workMinutesTotal: minutes,
  })
  .strict();
export type PatternDay = z.infer<typeof patternDay>;

/** PUT /api/admin/capacity/pattern body: all seven weekdays, each once. */
export const weeklyPatternPut = z
  .object({ days: z.array(patternDay).length(7) })
  .strict()
  .refine((p) => new Set(p.days.map((d) => d.weekday)).size === 7, 'each_weekday_once');
export type WeeklyPatternPut = z.infer<typeof weeklyPatternPut>;

export const patternRow = z.object({
  weekday: z.number().int(),
  is_working_day: z.boolean(),
  oven_minutes_total: z.number().int(),
  work_minutes_total: z.number().int(),
});

export function toPatternDay(row: z.infer<typeof patternRow>): PatternDay {
  return { weekday: row.weekday, isWorkingDay: row.is_working_day, ovenMinutesTotal: row.oven_minutes_total, workMinutesTotal: row.work_minutes_total };
}

/** What fn_materialize_capacity_from_pattern reports. */
export const materializeRow = z.object({
  from: z.string(),
  days: z.number().int(),
  written: z.number().int(),
  kept_manual: z.number().int(),
  kept_below_reserved: z.array(z.string()),
});
export const materializeResult = z.object({
  from: z.string(),
  days: z.number().int(),
  written: z.number().int(),
  keptManual: z.number().int(),
  keptBelowReserved: z.array(z.string()),
});
export type MaterializeResult = z.infer<typeof materializeResult>;

export function toMaterializeResult(row: z.infer<typeof materializeRow>): MaterializeResult {
  return { from: row.from, days: row.days, written: row.written, keptManual: row.kept_manual, keptBelowReserved: row.kept_below_reserved };
}
