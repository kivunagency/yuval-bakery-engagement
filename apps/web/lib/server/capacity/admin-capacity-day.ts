import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc } from '@/lib/server/supabase/rpc';
import { capacityErrorResult, type CapacityResult } from '@/lib/server/capacity/admin-capacity';
import { ledgerRow, toAdminDayCapacity, type AdminDayCapacity } from '@/lib/shared/contracts/capacity';
import {
  materializeRow,
  patternRow,
  toMaterializeResult,
  toPatternDay,
  type MaterializeResult,
  type PatternDay,
  type WeeklyPatternPut,
} from '@/lib/shared/contracts/capacity-pattern';

// Reads and writes behind the admin capacity screen (client-007). `client`
// is always createUserClient(): RLS lets an aal2 admin read orders and the
// pattern, and the DB functions check aal2 again and audit with auth.uid().

/** Orders that hold this day's minutes: the same statuses the ledger counts (ADR-002). */
export const CAPACITY_HOLDING_STATUSES = ['payment_pending', 'paid', 'fulfilled'] as const;

const orderRow = z.object({
  id: z.string(),
  order_number: z.string(),
  status: z.enum(CAPACITY_HOLDING_STATUSES),
  oven_minutes_cost: z.number().int(),
  work_minutes_cost: z.number().int(),
});

export type CapacityOrder = { id: string; orderNumber: string; unpaid: boolean; ovenMinutes: number; workMinutes: number };

export type CapacityDayView = {
  day: string;
  ledger: AdminDayCapacity | null;
  orders: CapacityOrder[];
  pattern: PatternDay[];
};

export async function loadCapacityDay(client: SupabaseClient, day: string): Promise<CapacityDayView> {
  const [ledger, orders, pattern] = await Promise.all([
    client.from('capacity_day_ledger').select('*').eq('day', day).maybeSingle(),
    client
      .from('orders')
      .select('id, order_number, status, oven_minutes_cost, work_minutes_cost')
      .eq('delivery_date', day)
      .in('status', [...CAPACITY_HOLDING_STATUSES])
      .order('created_at'),
    client.from('capacity_weekly_pattern').select('weekday, is_working_day, oven_minutes_total, work_minutes_total').order('weekday'),
  ]);
  if (ledger.error || orders.error || pattern.error) throw new Error('capacity_day_read_failed');
  return {
    day,
    ledger: ledger.data ? toAdminDayCapacity(ledgerRow.parse(ledger.data)) : null,
    orders: z.array(orderRow).parse(orders.data).map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      unpaid: o.status === 'payment_pending',
      ovenMinutes: o.oven_minutes_cost,
      workMinutes: o.work_minutes_cost,
    })),
    pattern: z.array(patternRow).parse(pattern.data).map(toPatternDay),
  };
}

export async function setWeeklyPattern(client: SupabaseClient, input: WeeklyPatternPut): Promise<CapacityResult<MaterializeResult>> {
  const p_pattern = input.days.map((d) => ({
    weekday: d.weekday,
    is_working_day: d.isWorkingDay,
    oven_minutes_total: d.ovenMinutesTotal,
    work_minutes_total: d.workMinutesTotal,
  }));
  try {
    const row = await callRpc(client, 'fn_admin_set_weekly_pattern', { p_pattern }, materializeRow);
    return { ok: true, value: toMaterializeResult(row) };
  } catch (e) {
    return capacityErrorResult(client, '', e);
  }
}

export async function resetDayToPattern(client: SupabaseClient, day: string): Promise<CapacityResult<AdminDayCapacity>> {
  try {
    const row = await callRpc(client, 'fn_admin_reset_day_to_pattern', { p_day: day }, ledgerRow);
    return { ok: true, value: toAdminDayCapacity(row) };
  } catch (e) {
    return capacityErrorResult(client, day, e);
  }
}
