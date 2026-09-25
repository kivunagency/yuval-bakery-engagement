import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTranslations } from 'next-intl/server';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { serverEnv } from '@/lib/server/env';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import { waMeHref } from '@/lib/shared/contact/links';
import { orderPageUrl } from '@/lib/shared/ordering/order-link';
import { shortDate } from '@/components/day-state/format';
import {
  capacityCheckRow,
  toCapacityCheck,
  type CustomCakeAdminError,
  type CustomCakeApprove,
  type CustomCakeApproveResponse,
  type CustomCakeCapacityCheck,
  type CustomCakeDeclineResponse,
} from '@/lib/shared/contracts/custom-cake';

// api-006: the admin side of a custom-cake request. `client` is always
// createUserClient(): the DB functions check is_admin_aal2() and audit with
// auth.uid(); no admin id ever comes from the browser. Approval is ONE call,
// fn_approve_custom_cake_request, which creates the order and reserves the
// minutes in the same transaction (ADR-002). This file never decides whether
// there is room: the capacity check and the reservation are both the DB's.
// This is the handler the ops registry (approveCustomCakeRequest /
// declineCustomCakeRequest, ADR-001 Rule 27) must reuse, not reimplement.

export type AdminResult<T> = { ok: true; value: T } | { ok: false; status: number; error: CustomCakeAdminError; check?: CustomCakeCapacityCheck };

function mapDbError(e: unknown): { status: number; error: CustomCakeAdminError } {
  if (e instanceof DbError) {
    if (e.code === 'admin_aal2_required') return { status: 401, error: 'unauthorized' };
    if (e.code === 'custom_cake_request_not_found') return { status: 404, error: 'not_found' };
    if (e.code === 'custom_cake_request_not_pending') return { status: 409, error: 'not_pending' };
    if (e.code === 'capacity_invalid_minutes') return { status: 400, error: 'invalid_input' };
    console.error('custom cake admin db error', e.code); // code only (SEC-026)
    return { status: 503, error: 'unavailable' };
  }
  throw e;
}

export async function checkCustomCakeCapacity(
  client: SupabaseClient,
  requestId: string,
  ovenMinutes: number,
  workMinutes: number,
): Promise<AdminResult<CustomCakeCapacityCheck>> {
  try {
    const row = await callRpc(
      client,
      'fn_admin_custom_cake_capacity_check',
      { p_request_id: requestId, p_oven_minutes: ovenMinutes, p_work_minutes: workMinutes },
      capacityCheckRow,
    );
    return { ok: true, value: toCapacityCheck(row) };
  } catch (e) {
    return { ok: false, ...mapDbError(e) };
  }
}

const requestRow = z.object({ requester_phone: z.string().nullable(), desired_date: z.string() });

async function loadRequestContact(client: SupabaseClient, requestId: string) {
  const { data, error } = await client.from('custom_cake_requests').select('requester_phone, desired_date').eq('id', requestId).maybeSingle();
  if (error || !data) return null;
  return requestRow.parse(data);
}

const approvedOrder = z.object({
  id: z.string(),
  order_number: z.string(),
  total_displayed: z.coerce.number(),
  payment_pending_expires_at: z.string(),
});

/** 128+ bit capability token for the guest's order page (SEC-003); only its hash is stored. */
function newLookupToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function approveCustomCake(
  client: SupabaseClient,
  requestId: string,
  input: CustomCakeApprove,
): Promise<AdminResult<CustomCakeApproveResponse>> {
  const contact = await loadRequestContact(client, requestId);
  if (!contact) return { ok: false, status: 404, error: 'not_found' };
  const token = newLookupToken();
  let order: z.infer<typeof approvedOrder>;
  try {
    order = await callRpc(
      client,
      'fn_approve_custom_cake_request',
      {
        p_request_id: requestId,
        p_price: input.price,
        p_oven_minutes: input.ovenMinutes,
        p_work_minutes: input.workMinutes,
        p_lookup_token: token,
        p_privacy_notice_version: TEXT_VERSIONS.privacy,
        p_terms_version: TEXT_VERSIONS.terms,
        p_cancellation_notice_version: TEXT_VERSIONS.cancellation,
      },
      approvedOrder,
    );
  } catch (e) {
    if (e instanceof DbError && e.code === 'capacity_changed_recheck_before_approving') {
      // Nothing was written (the whole approval rolled back). Send the screen
      // a fresh answer so it can say what changed.
      const fresh = await checkCustomCakeCapacity(client, requestId, input.ovenMinutes, input.workMinutes);
      return { ok: false, status: 409, error: 'capacity_changed', check: fresh.ok ? fresh.value : undefined };
    }
    return { ok: false, ...mapDbError(e) };
  }

  const link = orderPageUrl(serverEnv().SITE_URL, token);
  const t = await getTranslations('admin.custom_cake.whatsapp');
  const text = t('approved', {
    date: shortDate(contact.desired_date),
    price: order.total_displayed.toFixed(2).replace(/\.00$/, ''),
    orderNumber: order.order_number,
    link,
  });
  return {
    ok: true,
    value: {
      orderId: order.id,
      orderNumber: order.order_number,
      total: order.total_displayed,
      paymentPendingExpiresAt: order.payment_pending_expires_at,
      paymentPageUrl: link,
      whatsappHref: waMeHref(contact.requester_phone, text),
    },
  };
}

export async function declineCustomCake(client: SupabaseClient, requestId: string, reason: string): Promise<AdminResult<CustomCakeDeclineResponse>> {
  const contact = await loadRequestContact(client, requestId);
  if (!contact) return { ok: false, status: 404, error: 'not_found' };
  let declined: boolean;
  try {
    declined = await callRpc(client, 'fn_decline_custom_cake_request', { p_request_id: requestId, p_reason: reason === '' ? null : reason }, z.boolean());
  } catch (e) {
    return { ok: false, ...mapDbError(e) };
  }
  if (!declined) return { ok: false, status: 409, error: 'not_pending' };
  const t = await getTranslations('admin.custom_cake.whatsapp');
  const date = shortDate(contact.desired_date);
  const text = reason ? t('declined_with_reason', { date, reason }) : t('declined', { date });
  return { ok: true, value: { declined: true, whatsappHref: waMeHref(contact.requester_phone, text) } };
}
