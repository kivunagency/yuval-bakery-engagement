import { z } from 'zod';
import { isoDate } from '@/lib/shared/contracts/primitives';
import { DAY_STATES } from '@/lib/shared/types';

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
