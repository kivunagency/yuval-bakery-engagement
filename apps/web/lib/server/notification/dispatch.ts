import 'server-only';
import { createHash } from 'node:crypto';
import { readNotificationConfig, type NotificationConfig } from '@/lib/server/notification/config';
import { emailProviderFor, type EmailMessage, type EmailProvider } from '@/lib/server/notification/email/provider';
import { webPushSender, type PushSender } from '@/lib/server/notification/push/sender';
import { dbStore, type AttemptKey, type NotificationStore } from '@/lib/server/notification/store';
import * as tpl from '@/lib/server/notification/templates';
import { anonClient, serviceClient } from '@/lib/server/supabase/service';
import { jerusalemDate } from '@/lib/shared/time/jerusalem';
import type { PushPayload } from '@/lib/shared/contracts/push';
import type { ChannelOutcome, ConfirmationPdf, NotificationEvent, NotificationReport } from '@/lib/server/notification/types';

export type DispatchInput = { event: NotificationEvent; entityId: string; confirmationPdf?: ConfirmationPdf };

export type NotifierDeps = {
  store: NotificationStore;
  /** null: email not configured; every email is recorded as skipped with emailOffReason. */
  email: EmailProvider | null;
  emailOffReason: string;
  /** null: push not configured (no VAPID keys). */
  push: PushSender | null;
  siteUrl: string;
  /** false: customer emails are recorded as skipped, never sent (lib/server/features/index.ts). Default true. */
  customerEmail?: boolean;
  /** sha256 of the only addresses email may go to; null or absent = anyone. */
  recipientAllowlist?: ReadonlySet<string> | null;
};

function defaultDeps(): NotifierDeps {
  const config: NotificationConfig = readNotificationConfig();
  return {
    store: dbStore(serviceClient(), anonClient()),
    email: emailProviderFor(config.email),
    emailOffReason: config.email.provider === 'none' ? config.email.reason : '',
    push: config.push.enabled ? webPushSender(config.push) : null,
    siteUrl: config.siteUrl,
    customerEmail: config.customerEmail,
    recipientAllowlist: config.recipientAllowlist,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Recipient key for the caps: the address, trimmed and lower-cased, hashed. Never stored in clear. */
export const emailHash = (address: string) => sha256(address.trim().toLowerCase());
const pushHash = (subscriptionId: string) => sha256(`push:${subscriptionId}`);

// Admin screens these links open. The order and request detail routes belong
// to the admin orders / custom-cakes tasks; this is the one place the paths live.
export function adminLinks(siteUrl: string): tpl.Links {
  return {
    adminOrder: (orderId) => `${siteUrl}/admin/orders/${orderId}`,
    adminCustomCake: (requestId) => `${siteUrl}/admin/custom-cakes/${requestId}`,
  };
}

/** Looks like an address we can send to. Not validation of ownership, just "not garbage". */
const plausibleEmail = (s: string | null): s is string => !!s && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/**
 * Runs the notifications of one event. Never throws: every problem becomes an
 * outcome in the report and a row in notification_attempts (when the DB is
 * reachable at all). deps is for tests; callers use the default.
 */
export async function dispatch(input: DispatchInput, deps?: NotifierDeps): Promise<NotificationReport> {
  const report: NotificationReport = { event: input.event, entityId: input.entityId, outcomes: [] };
  try {
    const d = deps ?? defaultDeps();
    if (!UUID.test(input.entityId)) {
      report.outcomes.push({ channel: 'email', audience: 'admin', status: 'skipped', reason: 'invalid_entity_id' });
    } else {
      await run(input, d, report);
    }
  } catch (e) {
    // Config or DB unreachable before anything could be recorded.
    report.outcomes.push({ channel: 'email', audience: 'admin', status: 'failed', reason: 'internal_error' });
    console.error(JSON.stringify({ notification: input.event, entityId: input.entityId, error: e instanceof Error ? e.message : 'unknown' }));
  }
  // Ids and outcome codes only: no address, name or phone in function logs (SEC-026).
  console.log(JSON.stringify({ notification: report.event, entityId: report.entityId, outcomes: report.outcomes }));
  return report;
}

async function run(input: DispatchInput, d: NotifierDeps, report: NotificationReport): Promise<void> {
  const links = adminLinks(d.siteUrl);
  const out = (o: ChannelOutcome) => report.outcomes.push(o);
  const entityType = input.event === 'order_created' ? 'order' : input.event === 'payment_links_changed' ? 'setting_change' : 'custom_cake_request';
  const key = (channel: AttemptKey['channel'], audience: AttemptKey['audience']): AttemptKey => ({
    event: input.event, channel, audience, entityType, entityId: input.entityId,
  });
  const skip = async (k: AttemptKey, reason: string) => {
    await d.store.skipped(k, reason);
    out({ channel: k.channel, audience: k.audience, status: 'skipped', reason });
  };

  if (input.event === 'order_created') {
    const o = await d.store.orderFacts(input.entityId);
    if (!o) return skip(key('email', 'admin'), 'entity_not_found');
    await sendPushToAdmins(d, key('push', 'admin'), tpl.newOrderPush(o, links), out, skip);
    await sendToAdmins(d, key('email', 'admin'), tpl.newOrderEmail(o, links), out, skip);
    if (!plausibleEmail(o.customer_email)) return skip(key('email', 'customer'), 'no_customer_email');
    if (!input.confirmationPdf) return skip(key('email', 'customer'), 'confirmation_pdf_pending');
    const { url, ...attachment } = input.confirmationPdf;
    const message = { ...tpl.orderConfirmationEmail(o, await d.store.business(), url), to: o.customer_email.trim(), attachments: [attachment] };
    await sendEmail(d, key('email', 'customer'), message, out, skip);
    return;
  }

  if (input.event === 'payment_links_changed') {
    // SEC-009: every admin hears of it, by email always and by push as an extra.
    const f = await d.store.paymentLinksFacts(input.entityId);
    if (!f) return skip(key('email', 'admin'), 'entity_not_found');
    const settingsUrl = `${d.siteUrl}/admin/settings/payment`;
    await sendPushToAdmins(d, key('push', 'admin'), tpl.paymentLinksChangedPush(f, settingsUrl), out, skip);
    await sendToAdmins(d, key('email', 'admin'), tpl.paymentLinksChangedEmail(f, settingsUrl), out, skip);
    return;
  }

  const r = await d.store.customCakeFacts(input.entityId);
  if (!r) return skip(key('email', input.event === 'custom_cake_requested' ? 'admin' : 'customer'), 'entity_not_found');

  if (input.event === 'custom_cake_requested') {
    if (r.status !== 'pending_review') return skip(key('email', 'admin'), 'entity_not_in_expected_state');
    await sendPushToAdmins(d, key('push', 'admin'), tpl.newCustomCakePush(r, links), out, skip);
    await sendToAdmins(d, key('email', 'admin'), tpl.newCustomCakeEmail(r, links), out, skip);
    return;
  }

  const expected = input.event === 'custom_cake_approved' ? 'approved' : 'declined';
  if (r.status !== expected || (expected === 'approved' && !r.order_number)) return skip(key('email', 'customer'), 'entity_not_in_expected_state');
  // Web push to customers does not exist (subscriptions are admin-only, SEC-018);
  // a guest hears by email if given, else by Yuval's WhatsApp click-to-send (US-11).
  if (!plausibleEmail(r.requester_email)) return skip(key('email', 'customer'), 'no_customer_email');
  const business = await d.store.business();
  const content = expected === 'approved' ? tpl.customCakeApprovedEmail(r, business) : tpl.customCakeDeclinedEmail(r, business);
  await sendEmail(d, key('email', 'customer'), { ...content, to: r.requester_email.trim() }, out, skip);
}

type Out = (o: ChannelOutcome) => void;
type Skip = (k: AttemptKey, reason: string) => Promise<void>;

async function sendToAdmins(d: NotifierDeps, k: AttemptKey, content: Omit<EmailMessage, 'to'>, out: Out, skip: Skip) {
  const admins = await d.store.adminEmails();
  if (admins.length === 0) return skip(k, 'no_admin_email');
  for (const to of admins) await sendEmail(d, k, { ...content, to }, out, skip);
}

// One recipient's failure (even a DB error while recording it) never stops the
// other recipients or channels.
async function sendEmail(d: NotifierDeps, k: AttemptKey, message: EmailMessage, out: Out, skip: Skip) {
  try {
    await sendEmailUnguarded(d, k, message, out, skip);
  } catch (e) {
    out({ channel: 'email', audience: k.audience, status: 'failed', reason: 'internal_error' });
    console.error(JSON.stringify({ notification: k.event, entityId: k.entityId, channel: 'email', error: e instanceof Error ? e.message : 'unknown' }));
  }
}

async function sendEmailUnguarded(d: NotifierDeps, k: AttemptKey, message: EmailMessage, out: Out, skip: Skip) {
  if (!d.email) return skip(k, d.emailOffReason || 'email_provider_not_configured');
  // Both checks come before begin(): a mail that cannot be delivered must not
  // spend the daily cap or the recipient's cap.
  if (k.audience === 'customer' && d.customerEmail === false) return skip(k, 'customer_email_disabled');
  const recipient = emailHash(message.to);
  if (d.recipientAllowlist && !d.recipientAllowlist.has(recipient)) return skip(k, 'recipient_not_allowlisted');
  const begun = await d.store.begin(k, recipient);
  if (!begun.allowed || !begun.attempt_id) {
    out({ channel: 'email', audience: k.audience, status: begun.reason === 'duplicate' ? 'duplicate' : 'refused', reason: begun.reason });
    return;
  }
  const result = await d.email.send(message);
  await d.store.finish(begun.attempt_id, result.ok ? 'sent' : 'failed', result.ok ? null : result.error, result.ok ? result.id : null);
  out({ channel: 'email', audience: k.audience, status: result.ok ? 'sent' : 'failed', reason: result.ok ? null : result.error });

  if (begun.alert && begun.sent_today !== null && begun.hard_cap !== null) {
    // Rule 30: the day's count reached the alert threshold. One push to the
    // admin (email would spend the quota it warns about). Once per day, per device.
    const alertKey: AttemptKey = { event: 'email_quota_alert', channel: 'push', audience: 'admin', entityType: 'quota', entityId: jerusalemDate(new Date()) };
    console.warn(JSON.stringify({ notification: 'email_quota_alert', sentToday: begun.sent_today, hardCap: begun.hard_cap }));
    await sendPushToAdmins(d, alertKey, tpl.quotaAlertPush(begun.sent_today, begun.hard_cap, `${d.siteUrl}/admin/settings`), out, skip);
  }
}

async function sendPushToAdmins(d: NotifierDeps, k: AttemptKey, payload: PushPayload, out: Out, skip: Skip) {
  try {
    await sendPushUnguarded(d, k, payload, out, skip);
  } catch (e) {
    out({ channel: 'push', audience: 'admin', status: 'failed', reason: 'internal_error' });
    console.error(JSON.stringify({ notification: k.event, entityId: k.entityId, channel: 'push', error: e instanceof Error ? e.message : 'unknown' }));
  }
}

async function sendPushUnguarded(d: NotifierDeps, k: AttemptKey, payload: PushPayload, out: Out, skip: Skip) {
  if (!d.push) return skip(k, 'push_not_configured');
  const subs = await d.store.activePushSubscriptions();
  if (subs.length === 0) return skip(k, 'no_push_subscription');
  for (const sub of subs) {
    const begun = await d.store.begin(k, pushHash(sub.id));
    if (!begun.allowed || !begun.attempt_id) {
      out({ channel: 'push', audience: 'admin', status: begun.reason === 'duplicate' ? 'duplicate' : 'refused', reason: begun.reason });
      continue;
    }
    const result = await d.push.send(sub, payload);
    await d.store.finish(begun.attempt_id, result.ok ? 'sent' : 'failed', result.ok ? null : result.error, null);
    await d.store.pushResult(sub.id, !result.ok && result.gone);
    out({ channel: 'push', audience: 'admin', status: result.ok ? 'sent' : 'failed', reason: result.ok ? null : result.error });
  }
}
