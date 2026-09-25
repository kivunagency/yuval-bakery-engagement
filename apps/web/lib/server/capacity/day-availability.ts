import 'server-only';
import { z } from 'zod';
import { anonClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { capacityResponse, DEFAULT_DAY_RANGE, type CapacityResponse } from '@/lib/shared/contracts/capacity';
import { addDays, jerusalemDate } from '@/lib/shared/time/jerusalem';

// Public day availability (api-002), shared by GET /api/capacity and the
// catalog page. Runs as anon through the one function anon may call; the
// state and the product fit come from the DB as they are (Rule 19).

const rows = z.array(
  z.object({ day: z.string(), state: z.string(), fitting_product_ids: z.array(z.string()) }),
);

export async function getDayAvailability(from: string, to: string): Promise<CapacityResponse> {
  const data = await callRpc(anonClient(), 'fn_public_day_availability', { p_from: from, p_to: to }, rows);
  return capacityResponse.parse({
    days: data.map((r) => ({ day: r.day, state: r.state, fittingProductIds: r.fitting_product_ids })),
  });
}

/** The default window: today in Asia/Jerusalem and the days after it. */
export function defaultDayWindow(now: Date = new Date()): { from: string; to: string } {
  const from = jerusalemDate(now);
  return { from, to: addDays(from, DEFAULT_DAY_RANGE - 1) };
}
