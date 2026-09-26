import 'server-only';
import { z } from 'zod';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { stepUpTotp } from '@/lib/server/auth/admin-login';
import type { createUserClient } from '@/lib/server/supabase/server';
import { safePaymentLink, type PaymentMethod } from '@/lib/shared/payment/links';
import {
  paymentLinkSettings,
  type PaymentLinkSettings,
  type PaymentLinksUpdate,
  type PaymentLinksUpdateResponse,
  type PaymentSettingsApiErrorBody,
} from '@/lib/shared/contracts/payment-settings';

// Yuval's Bit and PayBox links, read and written by the admin (settings-payment,
// SEC-009). `client` is the route's createUserClient(): the step-up TOTP
// verification refreshes its session, and the same client then calls
// fn_admin_set_payment_links with the new token, whose TOTP step the DB
// checks (5 minutes). The caller emails every admin with the returned change
// id (PaymentLinksChanged). This is the handler the ops registry must reuse
// (Rule 27); an agent principal has no TOTP, so it can never change a link.

type UserClient = Awaited<ReturnType<typeof createUserClient>>;
export type PaymentResult<T> = { ok: true; value: T } | { ok: false; status: number; body: PaymentSettingsApiErrorBody };

const KEY: Record<PaymentMethod, string> = { bit: 'payment_link_bit', paybox: 'payment_link_paybox' };
const row = z.object({ key: z.string(), value: z.unknown(), updated_at: z.string(), updated_by: z.string().nullable() });

export async function loadPaymentLinkSettings(client: UserClient): Promise<PaymentLinkSettings> {
  const { data, error } = await client.from('app_settings').select('key, value, updated_at, updated_by').in('key', Object.values(KEY));
  if (error) throw new Error('payment_link_settings_read_failed');
  const rows = z.array(row).parse(data);
  const state = (method: PaymentMethod) => {
    const r = rows.find((x) => x.key === KEY[method]);
    const value = typeof r?.value === 'string' && r.value.trim() !== '' ? r.value : null;
    return { value, shownToCustomers: safePaymentLink(method, value) !== null, updatedAt: r?.updated_by ? r.updated_at : null }; // only a change an admin made
  };
  return paymentLinkSettings.parse({ bit: state('bit'), paybox: state('paybox') });
}

const setResult = z.object({ change_id: z.string().nullable(), changed: z.array(z.string()) });

export async function updatePaymentLinks(
  client: UserClient,
  input: PaymentLinksUpdate,
): Promise<PaymentResult<PaymentLinksUpdateResponse & { changeId: string | null }>> {
  const step = await stepUpTotp(client, input.code);
  if (!step.ok) {
    if (step.error === 'session_expired') return { ok: false, status: 401, body: { error: 'unauthorized' } };
    if (step.error === 'rate_limited') return { ok: false, status: 429, body: { error: 'rate_limited' } };
    if (step.error === 'unavailable') return { ok: false, status: 503, body: { error: 'server_error' } };
    return { ok: false, status: 401, body: { error: 'invalid_code' } };
  }
  const values: Record<string, string | null> = {};
  if (input.bit !== undefined) values[KEY.bit] = input.bit;
  if (input.paybox !== undefined) values[KEY.paybox] = input.paybox;
  try {
    const r = await callRpc(client, 'fn_admin_set_payment_links', { p_values: values }, setResult);
    const changed = (['bit', 'paybox'] as const).filter((m) => r.changed.includes(KEY[m]));
    return { ok: true, value: { ...(await loadPaymentLinkSettings(client)), changed, changeId: r.change_id } };
  } catch (e) {
    if (e instanceof DbError) {
      if (e.code === 'admin_aal2_required') return { ok: false, status: 401, body: { error: 'unauthorized' } };
      if (e.code === 'step_up_required') return { ok: false, status: 401, body: { error: 'step_up_required' } };
      if (e.code === 'settings_invalid_input') return { ok: false, status: 400, body: { error: 'invalid_input' } };
      if (e.code === 'settings_invalid_value' || e.code === 'setting_out_of_range') {
        const method = e.raw.includes('paybox') ? 'paybox' : 'bit';
        return { ok: false, status: 400, body: { error: 'invalid_input', fields: [method] } };
      }
    }
    console.error('fn_admin_set_payment_links failed', e instanceof Error ? e.message : 'unknown');
    return { ok: false, status: 500, body: { error: 'server_error' } };
  }
}
