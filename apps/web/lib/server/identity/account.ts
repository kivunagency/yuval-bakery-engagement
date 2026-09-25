import 'server-only';
import { z } from 'zod';
import { createUserClient } from '@/lib/server/supabase/server';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { getCustomerSession, type CustomerSession } from '@/lib/server/identity/customer-auth';
import {
  consentEvent,
  consentInput,
  customerProfile,
  myOrder,
  profileInput,
  unsubscribeToken,
  type ConsentEvent,
  type CustomerProfile,
  type MyOrder,
} from '@/lib/shared/contracts/registration';

// The signed-in customer's own data (s.13 access, s.14 correction) and the
// marketing consent (s.30A). Reads go through RLS as the customer's own JWT
// (own row only); writes only through the DB functions. The customer id is
// always the verified session's, never a value from the client.

const PROFILE_COLUMNS =
  'id, name, phone, email, birthday_day, birthday_month, anniversary_day, anniversary_month, marketing_opt_in, marketing_consent_version, marketing_opt_in_at, marketing_opt_out_at, age_confirmed_18_at, privacy_notice_version, created_at, deleted_at';

export type MyAccount = {
  session: CustomerSession;
  profile: CustomerProfile | null;
  consentEvents: ConsentEvent[];
  orders: MyOrder[];
};

/** Everything stored about the signed-in customer, or null when signed out. */
export async function loadMyAccount(): Promise<MyAccount | null> {
  const session = await getCustomerSession();
  if (!session) return null;
  const supabase = await createUserClient();
  const { data: row, error } = await supabase.from('customers').select(PROFILE_COLUMNS).eq('id', session.userId).maybeSingle();
  if (error) throw new Error(`account: profile read failed: ${error.message}`);
  if (!row) return { session, profile: null, consentEvents: [], orders: [] };

  const { data: events, error: eventsError } = await supabase
    .from('consent_events')
    .select('action, consent_version, source, created_at')
    .eq('customer_id', session.userId)
    .order('created_at', { ascending: false });
  if (eventsError) throw new Error(`account: consent read failed: ${eventsError.message}`);
  // RLS orders_select_own_registered: customer_id = auth.uid() only. Guest
  // orders are never matched by phone or email (SEC-003).
  const { data: orders, error: ordersError } = await supabase
    .from('orders')
    .select('order_number, status, fulfillment_type, delivery_date, total_displayed, created_at')
    .eq('customer_id', session.userId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (ordersError) throw new Error(`account: orders read failed: ${ordersError.message}`);
  return {
    session,
    profile: customerProfile.parse(row),
    consentEvents: z.array(consentEvent).parse(events ?? []),
    orders: z.array(myOrder).parse(orders ?? []),
  };
}

export type AccountWriteError = 'signed_out' | 'invalid_input' | 'phone_taken' | 'dates_need_consent' | 'not_registered' | 'unavailable';
export type AccountWriteResult = { ok: true } | { ok: false; error: AccountWriteError; fields?: string[] };

function mapDbError(e: unknown): AccountWriteResult {
  if (e instanceof DbError) {
    if (e.code === 'customer_phone_taken') return { ok: false, error: 'phone_taken', fields: ['phone'] };
    if (e.code === 'customer_dates_require_marketing_consent') return { ok: false, error: 'dates_need_consent' };
    if (e.code === 'customer_invalid_input' || e.code === 'customer_invalid_date' || e.code === 'consent_version_mismatch') return { ok: false, error: 'invalid_input' };
    if (e.code === 'customer_not_registered') return { ok: false, error: 'not_registered' };
    if (e.code === 'customer_sign_in_required' || e.code === 'consent_not_own') return { ok: false, error: 'signed_out' };
  }
  console.error('account: write failed', e instanceof Error ? e.message : e);
  return { ok: false, error: 'unavailable' };
}

/** Name, phone and (only with marketing consent) birthday/anniversary. */
export async function updateMyProfile(raw: unknown): Promise<AccountWriteResult> {
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_input', fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))].filter(Boolean) };
  }
  const session = await getCustomerSession();
  if (!session) return { ok: false, error: 'signed_out' };
  const { name, phone, birthday, anniversary } = parsed.data;
  try {
    await callRpc(
      await createUserClient(),
      'fn_update_my_profile',
      {
        p_name: name,
        p_phone: phone,
        p_birthday_day: birthday?.day ?? null,
        p_birthday_month: birthday?.month ?? null,
        p_anniversary_day: anniversary?.day ?? null,
        p_anniversary_month: anniversary?.month ?? null,
      },
      z.literal(true),
    );
    return { ok: true };
  } catch (e) {
    return mapDbError(e);
  }
}

/**
 * The customer's own marketing consent, through fn_set_marketing_consent only
 * (append-only consent_events, exact active version). A separate act from
 * registration and from saving the profile (s.30A).
 */
export async function setMyMarketingConsent(raw: unknown): Promise<AccountWriteResult> {
  const parsed = consentInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const session = await getCustomerSession();
  if (!session) return { ok: false, error: 'signed_out' };
  try {
    const found = await callRpc(
      await createUserClient(),
      'fn_set_marketing_consent',
      { p_customer_id: session.userId, p_action: parsed.data.action, p_consent_version: parsed.data.version, p_source: parsed.data.source },
      z.boolean(),
    );
    return found ? { ok: true } : { ok: false, error: 'not_registered' };
  } catch (e) {
    return mapDbError(e);
  }
}

export type UnsubscribeResult = 'done' | 'invalid' | 'unavailable';

/**
 * One-click unsubscribe (compliance-spec section 5, RFC 8058): no sign-in,
 * the token is the only key. Service role, the one caller fn_unsubscribe_by_token
 * accepts. Immediate; birthday/anniversary are erased with the consent.
 */
export async function unsubscribeByToken(raw: unknown): Promise<UnsubscribeResult> {
  const parsed = unsubscribeToken.safeParse(raw);
  if (!parsed.success) return 'invalid';
  try {
    const found = await callRpc(serviceClient(), 'fn_unsubscribe_by_token', { p_token: parsed.data }, z.boolean());
    return found ? 'done' : 'invalid';
  } catch (e) {
    console.error('unsubscribe failed', e instanceof Error ? e.message : e);
    return 'unavailable';
  }
}
