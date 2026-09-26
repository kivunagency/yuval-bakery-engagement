import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import {
  ORDER_RULES,
  ORDER_RULE_NAMES,
  orderSettings,
  type OrderRulesUpdate,
  type OrderSettings,
  type OrderSettingsApiErrorBody,
  type TimeSlotsUpdate,
} from '@/lib/shared/contracts/order-settings';

// Time slots and order rules (settings-slots), read and written by the admin.
// `client` is always createUserClient(): RLS lets an aal2 admin read every
// slot and setting; fn_admin_set_time_slots / fn_admin_set_order_rules check
// aal2 again, validate and audit (SEC-017). These are the handlers the ops
// registry must reuse (Rule 27).

export type OrderSettingsResult<T> = { ok: true; value: T } | { ok: false; status: number; body: OrderSettingsApiErrorBody };

const slotRow = z.object({ id: z.string(), start_time: z.string(), end_time: z.string() });
const settingRow = z.object({ key: z.string(), value: z.unknown(), updated_by: z.string().nullable() });

export async function loadOrderSettings(client: SupabaseClient): Promise<OrderSettings> {
  const keys = [...ORDER_RULE_NAMES.map((r) => ORDER_RULES[r].key), 'earliest_slot_time'];
  const [slots, settings] = await Promise.all([
    client.from('time_slots').select('id, start_time, end_time').eq('is_active', true).order('start_time'),
    client.from('app_settings').select('key, value, updated_by').in('key', keys),
  ]);
  if (slots.error || settings.error) throw new Error('order_settings_read_failed');
  const rows = z.array(settingRow).parse(settings.data);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const earliest = byKey.get('earliest_slot_time')?.value;
  return orderSettings.parse({
    slots: z.array(slotRow).parse(slots.data).map((s) => ({ id: s.id, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) })),
    earliestSlotTime: typeof earliest === 'string' ? earliest : null,
    rules: Object.fromEntries(
      ORDER_RULE_NAMES.map((r) => {
        const row = byKey.get(ORDER_RULES[r].key);
        return [r, { value: typeof row?.value === 'number' ? row.value : null, confirmed: row?.updated_by != null }];
      }),
    ),
  });
}

function mapError(e: unknown, fields: (raw: string) => string[]): OrderSettingsResult<never> {
  if (e instanceof DbError) {
    if (e.code === 'admin_aal2_required') return { ok: false, status: 401, body: { error: 'unauthorized' } };
    if (e.code === 'time_slots_overlap') return { ok: false, status: 400, body: { error: 'overlap' } };
    if (e.code === 'time_slots_invalid' || e.code === 'settings_invalid_input') return { ok: false, status: 400, body: { error: 'invalid_input' } };
    if (e.code === 'settings_invalid_value' || e.code === 'setting_out_of_range') return { ok: false, status: 400, body: { error: 'invalid_input', fields: fields(e.raw) } };
  }
  console.error('order settings write failed', e instanceof Error ? e.message : 'unknown');
  return { ok: false, status: 500, body: { error: 'server_error' } };
}

export async function updateTimeSlots(client: SupabaseClient, input: TimeSlotsUpdate): Promise<OrderSettingsResult<OrderSettings>> {
  try {
    await callRpc(client, 'fn_admin_set_time_slots', { p_slots: input.slots }, z.object({ slots: z.array(z.unknown()) }).passthrough());
    return { ok: true, value: await loadOrderSettings(client) };
  } catch (e) {
    return mapError(e, () => []);
  }
}

export async function updateOrderRules(client: SupabaseClient, input: OrderRulesUpdate): Promise<OrderSettingsResult<OrderSettings>> {
  const values: Record<string, number> = {};
  for (const r of ORDER_RULE_NAMES) if (input[r] !== undefined) values[ORDER_RULES[r].key] = input[r];
  try {
    await callRpc(client, 'fn_admin_set_order_rules', { p_values: values }, z.record(z.string(), z.unknown()));
    return { ok: true, value: await loadOrderSettings(client) };
  } catch (e) {
    return mapError(e, (raw) => ORDER_RULE_NAMES.filter((r) => raw.includes(ORDER_RULES[r].key)));
  }
}
