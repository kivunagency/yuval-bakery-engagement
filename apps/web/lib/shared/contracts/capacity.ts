import { z } from 'zod';
import { isoDate, minutes } from '@/lib/shared/contracts/primitives';
import { DAY_STATES } from '@/lib/shared/types';

// ---- public (api-002) ----
// GET /api/capacity (api-002). The public day strip: per day a state word and
// the products of which one unit still fits. Never minutes (design-tokens.md).
// The state and the fit are computed by the DB (fn_public_day_availability);
// nothing here derives them.

export const MAX_DAY_RANGE = 63;
export const DEFAULT_DAY_RANGE = 14;

export const capacityQuery = z
  .object({
    date: isoDate.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => !(q.date && (q.from || q.to)), 'date_excludes_from_to');

export const dayAvailability = z.object({
  day: isoDate,
  state: z.enum(DAY_STATES),
  fittingProductIds: z.array(z.guid()),
});
export type DayAvailability = z.infer<typeof dayAvailability>;

export const capacityResponse = z.object({
  days: z.array(dayAvailability).max(MAX_DAY_RANGE),
});
export type CapacityResponse = z.infer<typeof capacityResponse>;

// ---- admin (api-009, client-007) ----
// Admin capacity contracts (api-009, client-007). Minutes per day: 0..1440,
// the same bounds the DB enforces (capacity_invalid_minutes).

/** PATCH /api/admin/capacity/[date] body. Unknown keys are rejected. */
export const dayCapacityPatch = z
  .object({
    ovenMinutesTotal: minutes,
    workMinutesTotal: minutes,
    isBlackout: z.boolean(),
  })
  .strict();
export type DayCapacityPatch = z.infer<typeof dayCapacityPatch>;

export const capacityDayParam = isoDate;

export const DAY_SOURCES = ['manual', 'pattern'] as const;

/** One capacity_day_ledger row as the DB returns it. */
export const ledgerRow = z.object({
  day: z.string(),
  oven_minutes_total: z.number().int(),
  oven_minutes_reserved: z.number().int(),
  oven_minutes_unpaid_reserved: z.number().int(),
  work_minutes_total: z.number().int(),
  work_minutes_reserved: z.number().int(),
  work_minutes_unpaid_reserved: z.number().int(),
  is_blackout: z.boolean(),
  source: z.enum(DAY_SOURCES),
});
export type LedgerRow = z.infer<typeof ledgerRow>;

/** API response for one day. */
export const adminDayCapacity = z.object({
  day: isoDate,
  ovenMinutesTotal: z.number().int(),
  ovenMinutesReserved: z.number().int(),
  ovenMinutesUnpaidReserved: z.number().int(),
  workMinutesTotal: z.number().int(),
  workMinutesReserved: z.number().int(),
  workMinutesUnpaidReserved: z.number().int(),
  isBlackout: z.boolean(),
  source: z.enum(DAY_SOURCES),
});
export type AdminDayCapacity = z.infer<typeof adminDayCapacity>;

export function toAdminDayCapacity(row: LedgerRow): AdminDayCapacity {
  return adminDayCapacity.parse({
    day: row.day,
    ovenMinutesTotal: row.oven_minutes_total,
    ovenMinutesReserved: row.oven_minutes_reserved,
    ovenMinutesUnpaidReserved: row.oven_minutes_unpaid_reserved,
    workMinutesTotal: row.work_minutes_total,
    workMinutesReserved: row.work_minutes_reserved,
    workMinutesUnpaidReserved: row.work_minutes_unpaid_reserved,
    isBlackout: row.is_blackout,
    source: row.source,
  });
}

/** Error body of the admin capacity API. `reserved` is set for below_reserved. */
export const CAPACITY_API_ERRORS = ['unauthorized', 'forbidden_origin', 'invalid_input', 'below_reserved', 'no_pattern_for_weekday', 'server_error'] as const;
export type CapacityApiError = (typeof CAPACITY_API_ERRORS)[number];
export const capacityApiError = z.object({
  error: z.enum(CAPACITY_API_ERRORS),
  reserved: z.object({ ovenMinutes: z.number().int(), workMinutes: z.number().int() }).optional(),
});
export type CapacityApiErrorBody = z.infer<typeof capacityApiError>;
