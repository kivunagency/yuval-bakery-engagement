import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import {
  BUSINESS_SETTING_KEYS,
  VAT_STATUSES,
  businessSettings,
  toSettingValues,
  type BusinessSettings,
  type BusinessSettingsApiErrorBody,
  type BusinessSettingsUpdate,
} from '@/lib/shared/contracts/business-settings';

// Business details (s.14C) and osek status, read and written by the admin
// (settings-business). `client` is always createUserClient(): RLS lets an
// aal2 admin read every app_settings row, and fn_admin_set_business_details
// checks aal2 again, validates, and audits with auth.uid() (SEC-017). This is
// the handler the ops registry must reuse (Rule 27).

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; status: number; body: BusinessSettingsApiErrorBody };

const KEYS = Object.values(BUSINESS_SETTING_KEYS);
const row = z.object({ key: z.string(), value: z.unknown(), updated_by: z.string().nullable() });

const asText = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);

function toBusinessSettings(rows: z.infer<typeof row>[]): BusinessSettings {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const text = (key: string) => asText(byKey.get(key)?.value);
  const vat = byKey.get(BUSINESS_SETTING_KEYS.vatStatus);
  const vatStatus = VAT_STATUSES.find((s) => s === vat?.value) ?? null;
  return businessSettings.parse({
    name: text(BUSINESS_SETTING_KEYS.name),
    ownerName: text(BUSINESS_SETTING_KEYS.ownerName),
    registrationNumber: text(BUSINESS_SETTING_KEYS.registrationNumber),
    address: text(BUSINESS_SETTING_KEYS.address),
    phone: text(BUSINESS_SETTING_KEYS.phone),
    whatsapp: text(BUSINESS_SETTING_KEYS.whatsapp),
    email: text(BUSINESS_SETTING_KEYS.email),
    vatStatus,
    vatStatusConfirmed: vatStatus !== null && vat?.updated_by != null,
  });
}

/** Every business key, as the admin's own JWT (aal2 reads all rows through RLS). */
export async function loadBusinessSettings(client: SupabaseClient): Promise<BusinessSettings> {
  const { data, error } = await client.from('app_settings').select('key, value, updated_by').in('key', KEYS);
  if (error) throw new Error('business_settings_read_failed');
  return toBusinessSettings(z.array(row).parse(data));
}

export async function updateBusinessSettings(client: SupabaseClient, update: BusinessSettingsUpdate): Promise<SettingsResult<BusinessSettings>> {
  try {
    await callRpc(client, 'fn_admin_set_business_details', { p_values: toSettingValues(update) }, z.record(z.string(), z.unknown()));
    return { ok: true, value: await loadBusinessSettings(client) };
  } catch (e) {
    if (e instanceof DbError) {
      if (e.code === 'admin_aal2_required') return { ok: false, status: 401, body: { error: 'unauthorized' } };
      if (e.code === 'settings_invalid_input') return { ok: false, status: 400, body: { error: 'invalid_input' } };
      if (e.code === 'settings_invalid_value' || e.code === 'setting_out_of_range') {
        const key = e.raw.slice(e.raw.indexOf(':') + 1).trim();
        const field = Object.entries(BUSINESS_SETTING_KEYS).find(([, k]) => k === key)?.[0];
        return { ok: false, status: 400, body: { error: 'invalid_input', ...(field ? { fields: [field] } : {}) } };
      }
    }
    console.error('fn_admin_set_business_details failed', e instanceof Error ? e.message : 'unknown');
    return { ok: false, status: 500, body: { error: 'server_error' } };
  }
}
