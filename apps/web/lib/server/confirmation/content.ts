import 'server-only';
import { createTranslator } from 'next-intl';
import he from '@/messages/he.json';
import { formatIls, vatLabelKey } from '@/lib/shared/price/vat';
import { isolatedDate, weekdayKey } from '@/components/day-state/format';
import { displayPhone } from '@/lib/shared/contact/links';
import { isolate } from '@/lib/shared/text/bidi';
import { jerusalemDate } from '@/lib/shared/time/jerusalem';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import type { PublicSiteSettings } from '@/lib/shared/contracts/site-settings';
import type { PublicOrder } from '@/lib/server/ordering/order-by-token';
import type { Block, ConfirmationDocument } from '@/lib/server/confirmation/pdf';

// The words of the confirmation PDF (US-0c, s.14C(b)), from the same sources
// as the order page (Rule 15): the order is fn_order_public_view (the page's
// view), the strings are the page's own keys (payment.*, business.*,
// returns_policy.exemption_notice.*, the same the BusinessDetails "summary"
// and CancellationExemptionNotice components render), and the price helpers
// are the page's. Only what the page does not have lives under confirmation.pdf.
//
// Deliberately NOT in the document (compliance-schema-review.md section 2
// note 1): the customer's name, phone, email, street address and notes. The
// link lives 24 months and find-my-order can re-download it, so it carries
// what s.14C(b) asks for (business, product, price, date, cancellation) and
// nothing that identifies where the customer lives.
//
// Hebrew only: the site ships in Hebrew; the document is written once.

const t = createTranslator({ locale: 'he', messages: he });

function jerusalemDayOf(iso: string): string {
  const day = jerusalemDate(new Date(iso));
  return `⁦${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}.${day.slice(0, 4)}⁩`;
}

export function confirmationFilename(orderNumber: string): string {
  return `order-${orderNumber.replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}

export function buildConfirmationDocument(order: PublicOrder, settings: PublicSiteSettings, siteUrl: string): ConfirmationDocument {
  const o = order.view;
  const dayLabel = t('day_state.day_long', { weekday: t(`day_state.weekday_long.${weekdayKey(o.day)}`), date: isolatedDate(o.day) });
  const when =
    o.slotStart && o.slotEnd ? `${dayLabel}, ${isolate(t('payment.slot', { start: o.slotStart, end: o.slotEnd }))}` : dayLabel;
  const how = o.fulfillment === 'delivery' ? t('payment.delivery_to', { city: isolate(o.city ?? '') }) : t('payment.pickup');
  const orderNumber = `⁦${o.orderNumber}⁩`;

  const s = settings;
  const regStatus = s.vat_status === 'licensed' ? t('business.status.licensed') : s.vat_status === 'exempt' ? t('business.status.exempt') : null;
  const phone = displayPhone(s.business_phone);

  const blocks: Block[] = [
    { kind: 'title', text: t('confirmation.pdf.title') },
    { kind: 'subtitle', text: s.business_name ?? t('business.details.name') },
    { kind: 'text', text: t('confirmation.pdf.order_number', { orderNumber }) },
    { kind: 'text', text: t('confirmation.pdf.ordered_on', { date: jerusalemDayOf(order.createdAt) }), muted: true },
    { kind: 'rule' },

    { kind: 'heading', text: t('payment.details_heading') },
    { kind: 'text', text: `${t('payment.when')}: ${when}` },
    { kind: 'text', text: `${t('payment.how')}: ${how}` },
    { kind: 'heading', text: t('payment.items_heading') },
    ...o.items.map((i): Block => ({ kind: 'row', label: t('payment.line', { name: isolate(i.name), quantity: i.quantity }), value: formatIls(i.lineTotal) })),
    ...(o.fulfillment === 'delivery' ? [{ kind: 'row', label: t('payment.delivery_fee'), value: formatIls(o.deliveryFee) } as Block] : []),
    { kind: 'rule' },
    { kind: 'row', label: t('confirmation.pdf.total_with_label', { label: t(`business.${vatLabelKey(s.vat_status)}`) }), value: formatIls(o.total), strong: true },

    { kind: 'heading', text: t('confirmation.pdf.payment_heading') },
    { kind: 'text', text: t('business.page.payment_body') },
    { kind: 'text', text: t('confirmation.pdf.payment_note', { orderNumber }) },

    { kind: 'heading', text: t('returns_policy.exemption_notice.title') },
    { kind: 'text', text: o.source === 'custom_cake' ? t('returns_policy.exemption_notice.custom_cake') : t('returns_policy.exemption_notice.catalog') },
    { kind: 'text', text: t('returns_policy.exemption_notice.before_payment') },
    { kind: 'text', text: t('returns_policy.exemption_notice.defects') },
    { kind: 'text', text: `${t('returns_policy.exemption_notice.version')} ⁦${TEXT_VERSIONS.cancellation}⁩`, muted: true, small: true },

    { kind: 'heading', text: t('business.details.contact') },
    { kind: 'text', text: `${t('business.labels.name')}: ${s.business_name ?? t('business.details.name')}` },
    {
      kind: 'text',
      text: `${t('business.labels.registration')}: ${
        s.business_registration_number && regStatus ? `${regStatus} ⁦${s.business_registration_number}⁩` : t('business.details.registration_number')
      }`,
    },
    { kind: 'text', text: `${t('business.labels.phone')}: ${phone ? `⁦${phone}⁩` : t('business.details.phone')}` },
    { kind: 'text', text: `${t('business.labels.email')}: ${s.business_email ? `⁦${s.business_email}⁩` : t('business.details.email')}` },
    { kind: 'text', text: t('confirmation.pdf.business_link', { url: `⁦${siteUrl}/business⁩` }) },
    { kind: 'rule' },
    { kind: 'text', text: t('confirmation.pdf.footer', { date: jerusalemDayOf(new Date().toISOString()) }), muted: true, small: true },
  ];

  return { title: `${t('confirmation.pdf.title')} ${o.orderNumber}`, createdAt: new Date(order.createdAt), blocks };
}
