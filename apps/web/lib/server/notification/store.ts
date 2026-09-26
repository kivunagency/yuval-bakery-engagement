import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { callRpc } from '@/lib/server/supabase/rpc';
import { publicSiteSettings } from '@/lib/shared/contracts/site-settings';
import type { Audience, Channel, NotificationEvent } from '@/lib/server/notification/types';
import type { BusinessFacts, CustomCakeFacts, OrderFacts } from '@/lib/server/notification/templates';
import type { PushTarget } from '@/lib/server/notification/push/sender';

// Everything the notification context reads or writes in the DB, through the
// service_role functions of migration 20260926110000 (never a table directly).

const money = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().nonnegative());
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const orderFactsRow = z.object({
  order_id: z.guid(),
  order_number: z.string().min(1).max(40),
  status: z.string(),
  order_source: z.string(),
  customer_name: z.string().nullable(),
  customer_email: z.string().nullable(),
  fulfillment_type: z.string(),
  delivery_date: isoDay,
  total_displayed: money,
  payment_pending_expires_at: z.string().nullable(),
});
export type OrderFactsRow = OrderFacts & z.infer<typeof orderFactsRow>;

const customCakeFactsRow = z.object({
  request_id: z.guid(),
  status: z.string(),
  requester_name: z.string().nullable(),
  requester_email: z.string().nullable(),
  desired_date: isoDay,
  price_displayed: money.nullable(),
  decline_reason: z.string().nullable(),
  order_id: z.guid().nullable(),
  order_number: z.string().nullable(),
  payment_pending_expires_at: z.string().nullable(),
});
export type CustomCakeFactsRow = CustomCakeFacts & z.infer<typeof customCakeFactsRow>;

const jsonText = z.unknown().transform((v) => (typeof v === 'string' ? v : null));
const paymentLinksFactsRow = z.object({
  change_id: z.guid(),
  changed_at: z.string(),
  admin_name: z.string().nullable(),
  bit_changed: z.boolean(),
  paybox_changed: z.boolean(),
  bit_link: jsonText,
  paybox_link: jsonText,
});
export type PaymentLinksFactsRow = z.infer<typeof paymentLinksFactsRow>;

const beginResult = z.object({
  attempt_id: z.guid().nullable(),
  allowed: z.boolean(),
  reason: z.string().nullable(),
  alert: z.boolean(),
  sent_today: z.number().int().nullable(),
  hard_cap: z.number().int().nullable(),
});
export type BeginResult = z.infer<typeof beginResult>;

export type AttemptKey = { event: NotificationEvent; channel: Channel; audience: Audience; entityType: 'order' | 'custom_cake_request' | 'quota' | 'setting_change'; entityId: string };

export interface NotificationStore {
  orderFacts(orderId: string): Promise<OrderFactsRow | null>;
  customCakeFacts(requestId: string): Promise<CustomCakeFactsRow | null>;
  paymentLinksFacts(changeId: string): Promise<PaymentLinksFactsRow | null>;
  adminEmails(): Promise<string[]>;
  business(): Promise<BusinessFacts>;
  activePushSubscriptions(): Promise<PushTarget[]>;
  begin(key: AttemptKey, recipientHash: string): Promise<BeginResult>;
  finish(attemptId: string, status: 'sent' | 'failed', reason: string | null, providerMessageId: string | null): Promise<void>;
  skipped(key: AttemptKey, reason: string): Promise<void>;
  pushResult(subscriptionId: string, gone: boolean): Promise<void>;
}

/** service must be the service-role client; anon is used only for the public business settings. */
export function dbStore(service: SupabaseClient, anon: SupabaseClient): NotificationStore {
  const keyArgs = (k: AttemptKey) => ({ p_event: k.event, p_channel: k.channel, p_audience: k.audience, p_entity_type: k.entityType, p_entity_id: k.entityId });
  return {
    async orderFacts(orderId) {
      const rows = await callRpc(service, 'fn_notification_order_facts', { p_order_id: orderId }, z.array(orderFactsRow));
      return rows[0] ?? null;
    },
    async customCakeFacts(requestId) {
      const rows = await callRpc(service, 'fn_notification_custom_cake_facts', { p_request_id: requestId }, z.array(customCakeFactsRow));
      return rows[0] ?? null;
    },
    async paymentLinksFacts(changeId) {
      const rows = await callRpc(service, 'fn_notification_payment_links_facts', { p_change_id: changeId }, z.array(paymentLinksFactsRow));
      return rows[0] ?? null;
    },
    async adminEmails() {
      const rows = await callRpc(service, 'fn_notification_admin_emails', {}, z.array(z.object({ email: z.string() })));
      return rows.map((r) => r.email);
    },
    async business() {
      try {
        const s = await callRpc(anon, 'fn_public_site_settings', {}, publicSiteSettings);
        return { name: s.business_name, phone: s.business_phone };
      } catch {
        return { name: null, phone: null }; // placeholders, never invented values
      }
    },
    async activePushSubscriptions() {
      return callRpc(
        service,
        'fn_notification_active_push_subscriptions',
        {},
        z.array(z.object({ id: z.guid(), endpoint: z.string(), p256dh: z.string(), auth_key: z.string() })),
      );
    },
    async begin(k, recipientHash) {
      return callRpc(service, 'fn_notification_begin', { ...keyArgs(k), p_recipient_hash: recipientHash }, beginResult);
    },
    async finish(attemptId, status, reason, providerMessageId) {
      await callRpc(service, 'fn_notification_finish', { p_attempt_id: attemptId, p_status: status, p_reason: reason, p_provider_message_id: providerMessageId }, z.unknown());
    },
    async skipped(k, reason) {
      await callRpc(service, 'fn_notification_record_skipped', { ...keyArgs(k), p_reason: reason }, z.unknown());
    },
    async pushResult(subscriptionId, gone) {
      await callRpc(service, 'fn_notification_push_result', { p_subscription_id: subscriptionId, p_gone: gone }, z.unknown());
    },
  };
}
