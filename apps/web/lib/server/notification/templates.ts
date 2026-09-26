import 'server-only';
import { createTranslator } from 'next-intl';
import he from '@/messages/he.json';
import { formatPrice } from '@/components/price/Price';
import { isolatedDate } from '@/components/day-state/format';
import type { EmailMessage } from '@/lib/server/notification/email/provider';
import type { PushPayload } from '@/lib/shared/contracts/push';

// Every outgoing text is built here from the DB facts and messages/he.json
// (the shipped UI language). Rules (SEC-015, SEC-018):
// - Customer-facing emails carry NO text the customer typed: no name, no
//   inscription, no notes. Only order number, dates, amounts, and the reason
//   Yuval wrote when declining.
// - Admin emails carry the customer's name (US-10), cut to 60 characters,
//   hidden when it looks like a link, HTML-escaped.
// - Push payloads carry the order number and a link only: they show on a
//   lock screen, so no name, phone or address.
// - Transactional only: no marketing content in any of these.

const t = createTranslator({ locale: 'he', messages: he, namespace: 'notification' });
const tBusiness = createTranslator({ locale: 'he', messages: he, namespace: 'business' });
const tConfirmation = createTranslator({ locale: 'he', messages: he, namespace: 'confirmation.email' });

const NAME_MAX = 60;
const REASON_MAX = 500;
// Bidi and other control characters: they can reorder a line to fake content.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const LINK_LIKE = /(https?:|www\.|:\/\/|@|\b[a-z0-9-]+\.(com|net|org|info|io|co|il|ly|me|xyz|biz|app|link|site|online|top)\b)/i;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function cleanText(s: string | null | undefined, max: number): string {
  return (s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The customer's name as an admin message may show it. */
export function safeCustomerName(name: string | null | undefined): string {
  const clean = cleanText(name, NAME_MAX);
  if (!clean) return t('common.name_missing');
  return LINK_LIKE.test(clean) ? t('common.name_hidden') : clean;
}

/** "14.10, 16:00" in Asia/Jerusalem. */
export function jerusalemDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `⁦${get('day')}.${get('month')}, ${get('hour')}:${get('minute')}⁩`;
}

// ---------------------------------------------------------------- facts

export type OrderFacts = {
  order_id: string;
  order_number: string;
  customer_name: string | null;
  fulfillment_type: string;
  delivery_date: string;
  total_displayed: number;
};

export type CustomCakeFacts = {
  request_id: string;
  requester_name: string | null;
  desired_date: string;
  price_displayed: number | null;
  decline_reason: string | null;
  order_number: string | null;
  payment_pending_expires_at: string | null;
};

export type BusinessFacts = { name: string | null; phone: string | null };

export type Links = { adminOrder: (orderId: string) => string; adminCustomCake: (requestId: string) => string };

// ---------------------------------------------------------------- email layout

type Block = { kind: 'p'; html: string; text: string } | { kind: 'cta'; href: string; label: string };

function layout(subject: string, blocks: Block[], footer: string): Omit<EmailMessage, 'to'> {
  const body = blocks
    .map((b) =>
      b.kind === 'p'
        ? `<p style="margin:0 0 12px">${b.html}</p>`
        : `<p style="margin:16px 0"><a href="${escapeHtml(b.href)}" style="display:inline-block;padding:12px 20px;background:#6b3a2a;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(b.label)}</a></p>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#fbf7f2;color:#2b1d16;font-family:Arial,'IBM Plex Sans Hebrew',sans-serif;font-size:16px;line-height:1.6;direction:rtl;text-align:right">
<div dir="rtl" style="max-width:560px;margin:0 auto">
${body}
<p style="margin:24px 0 0;font-size:13px;color:#6b5a50">${escapeHtml(footer)}</p>
</div></body></html>`;
  const text = [...blocks.map((b) => (b.kind === 'p' ? b.text : `${b.label}: ${b.href}`)), '', footer].join('\n');
  return { subject, html, text };
}

// A message with {placeholders} becomes a plain-text line and an HTML line.
// The values are marked, the message is formatted once, then split on the
// marks: in HTML each value is escaped and isolated (<bdi>) so a number,
// date or name keeps its own direction inside the Hebrew sentence.
function msg(key: Parameters<typeof t>[0], values: Record<string, string>): Block {
  const marked = Object.fromEntries(Object.keys(values).map((k) => [k, `\u0000${k}\u0000`]));
  const parts = t(key, marked).split(/\u0000([a-zA-Z]+)\u0000/);
  return {
    kind: 'p',
    text: parts.map((part, i) => (i % 2 === 1 ? (values[part] ?? '') : part)).join(''),
    html: parts.map((part, i) => (i % 2 === 1 ? `<bdi>${escapeHtml(values[part] ?? '')}</bdi>` : escapeHtml(part))).join(''),
  };
}

function businessName(b: BusinessFacts): string {
  return cleanText(b.name, 100) || tBusiness('details.name');
}

function contactLine(b: BusinessFacts): Block {
  return msg('common.contact', { phone: cleanText(b.phone, 30) || tBusiness('details.phone') });
}

// ---------------------------------------------------------------- admin emails

export function newOrderEmail(o: OrderFacts, links: Links): Omit<EmailMessage, 'to'> {
  const values = {
    customerName: safeCustomerName(o.customer_name),
    orderNumber: o.order_number,
    date: isolatedDate(o.delivery_date),
    fulfillment: t(o.fulfillment_type === 'delivery' ? 'common.fulfillment.delivery' : 'common.fulfillment.pickup'),
    total: formatPrice(Number(o.total_displayed)),
  };
  return layout(
    t('new_order.subject', { orderNumber: o.order_number }),
    [msg('new_order.body', values), { kind: 'cta', href: links.adminOrder(o.order_id), label: t('new_order.cta') }],
    t('common.footer_admin'),
  );
}

export function newCustomCakeEmail(r: CustomCakeFacts, links: Links): Omit<EmailMessage, 'to'> {
  const customerName = safeCustomerName(r.requester_name);
  return layout(
    t('new_custom_cake.subject', { customerName }),
    [msg('new_custom_cake.body', { customerName, date: isolatedDate(r.desired_date) }), { kind: 'cta', href: links.adminCustomCake(r.request_id), label: t('new_custom_cake.cta') }],
    t('common.footer_admin'),
  );
}

// ---------------------------------------------------------------- customer emails (no customer text)

/** confirmationUrl: the 24-month link to the same PDF (US-0c), built by the server from the order id, never from customer input. */
export function orderConfirmationEmail(o: OrderFacts, b: BusinessFacts, confirmationUrl?: string): Omit<EmailMessage, 'to'> {
  const link: Block[] = confirmationUrl
    ? [
        { kind: 'p', text: tConfirmation('link_intro'), html: escapeHtml(tConfirmation('link_intro')) },
        { kind: 'cta', href: confirmationUrl, label: tConfirmation('link_cta') },
      ]
    : [];
  return layout(
    t('order_confirmation.subject', { orderNumber: o.order_number }),
    [
      msg('order_confirmation.body', { orderNumber: o.order_number, date: isolatedDate(o.delivery_date) }),
      msg('order_confirmation.payment', {}),
      ...link,
      contactLine(b),
    ],
    t('common.footer_customer', { businessName: businessName(b) }),
  );
}

export function customCakeApprovedEmail(r: CustomCakeFacts, b: BusinessFacts): Omit<EmailMessage, 'to'> {
  const orderNumber = r.order_number ?? '';
  const blocks: Block[] = [
    msg('custom_cake_approved.body', {
      date: isolatedDate(r.desired_date),
      price: r.price_displayed === null ? '' : formatPrice(Number(r.price_displayed)),
      orderNumber,
    }),
  ];
  if (r.payment_pending_expires_at) blocks.push(msg('custom_cake_approved.payment', { deadline: jerusalemDateTime(r.payment_pending_expires_at) }));
  blocks.push(contactLine(b));
  return layout(t('custom_cake_approved.subject', { orderNumber }), blocks, t('common.footer_customer', { businessName: businessName(b) }));
}

export function customCakeDeclinedEmail(r: CustomCakeFacts, b: BusinessFacts): Omit<EmailMessage, 'to'> {
  const blocks: Block[] = [msg('custom_cake_declined.body', { date: isolatedDate(r.desired_date) })];
  // Written by Yuval, never by the customer (threat-model 3.5); escaped like everything else.
  const reason = cleanText(r.decline_reason, REASON_MAX);
  if (reason) blocks.push(msg('custom_cake_declined.reason', { reason }));
  blocks.push(contactLine(b));
  return layout(t('custom_cake_declined.subject'), blocks, t('common.footer_customer', { businessName: businessName(b) }));
}

// ---------------------------------------------------------------- push (lock screen: no PII)

export function newOrderPush(o: Pick<OrderFacts, 'order_id' | 'order_number'>, links: Links): PushPayload {
  return {
    title: t('push.new_order_title', { orderNumber: o.order_number }),
    body: t('push.new_order_body'),
    url: links.adminOrder(o.order_id),
    tag: `order-${o.order_id}`,
  };
}

export function newCustomCakePush(r: Pick<CustomCakeFacts, 'request_id'>, links: Links): PushPayload {
  return { title: t('push.new_custom_cake_title'), body: t('push.new_custom_cake_body'), url: links.adminCustomCake(r.request_id), tag: `custom-cake-${r.request_id}` };
}

export function quotaAlertPush(count: number, cap: number, settingsUrl: string): PushPayload {
  return {
    title: t('push.quota_title', { count: String(count), cap: String(cap) }),
    body: t('push.quota_body', { cap: String(cap) }),
    url: settingsUrl,
    tag: 'email-quota',
  };
}
