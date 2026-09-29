import 'server-only';
import { z } from 'zod';
import { anonClient } from '@/lib/server/supabase/service';
import { timeSlot, type TimeSlot } from '@/lib/shared/contracts/checkout';

// Active time slots (api-003), read as anon: RLS time_slots_select_public
// returns active slots only. Rendered into the checkout page by the server.
const row = z.object({ id: z.string(), start_time: z.string(), end_time: z.string() });

export async function getActiveTimeSlots(): Promise<TimeSlot[]> {
  const { data, error } = await anonClient().from('time_slots').select('id, start_time, end_time').order('start_time');
  if (error) throw new Error(`time slots unavailable: ${error.code}`);
  return z.array(row).parse(data).map((s) => timeSlot.parse({ id: s.id, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }));
}
