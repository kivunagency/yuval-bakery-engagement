import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getOrderByToken } from '@/lib/server/ordering/order-by-token';
import { getPaymentLinks } from '@/lib/server/payment/payment-links';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { BusinessDetails, CancellationExemptionNotice } from '@/components/compliance';
import { ContactBlock } from '@/components/contact-block';
import { PriceWithVat } from '@/components/price';
import { formatIls } from '@/lib/shared/price/vat';
import { isolatedDate, weekdayKey } from '@/components/day-state/format';
import { CopyOrderNumber } from '@/components/order/CopyOrderNumber';
import { jerusalemDate, jerusalemHhmm } from '@/lib/shared/time/jerusalem';
import { isolate } from '@/lib/shared/text/bidi';
import styles from '@/components/order/order.module.css';

// The order and payment page (client-004), reached only through the
// capability token from checkout (SEC-003), never an order number. Unknown,
// expired and malformed tokens get the same 404. next.config.ts sends
// Referrer-Policy: no-referrer and X-Robots-Tag: noindex for /order/*, so the
// token does not leak to Bit/PayBox through the Referer; links also carry
// rel="noreferrer". Server component: the order, the payment links and the
// business details are read here; only the copy button runs in the browser.
//
// Seam for wave 3: the confirmation PDF (US-0c) is generated from the same
// getOrderByToken() view (Rule 15) and its download link goes where
// data-testid="confirmation-seam" is. Find-my-order (US-0d) lands on this
// same page once it has issued a token.

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('payment.page_title')} | ${t('business.details.name')}`, robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

export default async function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const order = await getOrderByToken(token);
  if (!order) notFound();

  const [t, td, links, settings] = await Promise.all([
    getTranslations('payment'),
    getTranslations('day_state'),
    getPaymentLinks(),
    getPublicSiteSettings(),
  ]);
  const dayLabel = (d: string) => td('day_long', { weekday: td(`weekday_long.${weekdayKey(d)}`), date: isolatedDate(d) });
  const pending = order.status === 'payment_pending';
  const expires = order.paymentPendingExpiresAt ? new Date(order.paymentPendingExpiresAt) : null;
  const expiresDay = expires ? jerusalemDate(expires) : null;
  const hold =
    expires && expiresDay
      ? expiresDay === jerusalemDate(new Date())
        ? t('hold_today', { time: jerusalemHhmm(expires) })
        : t('hold_other_day', { time: jerusalemHhmm(expires), day: dayLabel(expiresDay) })
      : null;
  const amount = formatIls(order.total);
  const code = <span className="ltr">{order.orderNumber}</span>;

  const payButton = (method: 'bit' | 'paybox', href: string | null) =>
    href ? (
      <a className={styles.pay} href={href} rel="noreferrer noopener" data-testid={`pay-${method}`}>
        {t(`${method}_link`)}
      </a>
    ) : (
      <p className={`${styles.pay} ${styles.payPlaceholder}`} data-testid={`pay-${method}-placeholder`}>
        <span>{t(`${method}_link`)}</span>
        <span className={styles.placeholderText}>{t('link_placeholder', { method: method === 'bit' ? 'Bit' : 'PayBox' })}</span>
      </p>
    );

  return (
    <main id="main" className={styles.main}>
      <header className={styles.appbar}>
        <h1 className={styles.brand}>{settings.business_name ?? t('page_title')}</h1>
      </header>

      {pending ? (
        <p className={styles.saved} role="status" data-testid="order-saved">
          {t('saved', { day: dayLabel(order.day) })}
        </p>
      ) : (
        <p className={styles.statusLine} role="status" data-testid="order-status" data-status={order.status}>
          {t(`status.${order.status}`)}
        </p>
      )}

      <section className={styles.codeCard} aria-labelledby="code-heading">
        <h2 id="code-heading">{t('order_number_heading')}</h2>
        <div className={styles.codeRow}>
          <span className={styles.code} data-testid="order-number">
            {code}
          </span>
          <CopyOrderNumber orderNumber={order.orderNumber} />
        </div>
        <div className={styles.amountLine}>
          <b>{t('amount')}</b>
          <span className={styles.big} data-testid="order-total">
            <PriceWithVat amount={order.total} vatStatus={settings.vat_status} />
          </span>
        </div>
        {pending && hold ? (
          <p className={styles.hold} data-testid="hold-until">
            {hold}
          </p>
        ) : null}

        {pending ? (
          <div className={styles.paybtns} role="group" aria-label={t('methods_heading')}>
            {payButton('bit', links.bit)}
            {payButton('paybox', links.paybox)}
          </div>
        ) : null}
      </section>

      {pending ? (
        <ol className={styles.steps}>
          <li>
            <i className="num" aria-hidden="true">1</i>
            <span>{t('instructions.step1', { amount })}</span>
          </li>
          <li>
            <i className="num" aria-hidden="true">2</i>
            <span>{t.rich('instructions.step2', { orderNumber: order.orderNumber, b: (c) => <b className="ltr">{c}</b> })}</span>
          </li>
          <li>
            <i className="num" aria-hidden="true">3</i>
            <span>{t('instructions.step3')}</span>
          </li>
        </ol>
      ) : null}
      <p className={styles.keep}>{t('keep_link')}</p>

      <section className={styles.details} aria-labelledby="details-heading" data-testid="order-details">
        <h2 id="details-heading">{t('details_heading')}</h2>
        <dl>
          <div>
            <dt>{t('when')}</dt>
            <dd>
              {dayLabel(order.day)}
              {order.slotStart && order.slotEnd ? (
                <>
                  {', '}
                  <span className="num">{t('slot', { start: order.slotStart, end: order.slotEnd })}</span>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>{t('how')}</dt>
            <dd>{order.fulfillment === 'delivery' ? t('delivery_to', { city: isolate(order.city ?? '') }) : t('pickup')}</dd>
          </div>
        </dl>
        <h3 className={styles.itemsH}>{t('items_heading')}</h3>
        {order.items.map((i, n) => (
          <div className={styles.row} key={n}>
            <span>{t('line', { name: isolate(i.name), quantity: i.quantity })}</span>
            <span className="num">{formatIls(i.lineTotal)}</span>
          </div>
        ))}
        {order.fulfillment === 'delivery' ? (
          <div className={styles.row}>
            <span>{t('delivery_fee')}</span>
            <span className="num">{formatIls(order.deliveryFee)}</span>
          </div>
        ) : null}
        <div className={`${styles.row} ${styles.totalRow}`}>
          <b>{t('total')}</b>
          <b className="num">{amount}</b>
        </div>
      </section>

      <div data-testid="confirmation-seam" hidden />

      <div className={styles.legal}>
        <CancellationExemptionNotice kind="catalog" />
        <BusinessDetails settings={settings} variant="summary" />
        <ContactBlock phone={settings.business_phone} whatsapp={settings.business_whatsapp} orderNumber={order.orderNumber} headingId="order-contact-heading" />
      </div>
    </main>
  );
}
