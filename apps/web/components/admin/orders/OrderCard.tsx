import { useTranslations } from 'next-intl';
import { PriceAmount } from '@/components/price';
import { displayPhone } from '@/lib/shared/contact/links';
import type { AdminOrderView } from '@/lib/shared/contracts/admin-orders';
import { OrderActions } from './OrderActions';

export type OrderCardLabels = {
  /** Weekday name and short date of the delivery day, and both together. */
  weekday: string;
  date: string;
  day: string;
  /** WhatsApp link built on the server from a fixed template (SEC-024), or null without a valid phone. */
  whatsappHref: string | null;
  /** Jerusalem date and time of the expiry (pending) or of when it expired. */
  expiry: { date: string; time: string } | null;
  /** Expired for a day that has not passed yet: may have been paid late (blindspot-005). */
  checkLatePayment: boolean;
  /**
   * US-0c, only for a paid order with no email whose written confirmation was
   * not delivered yet: the WhatsApp link carrying the confirmation PDF link
   * (null without a valid phone), or linkAvailable false when the link could
   * not be built (secret missing).
   */
  confirmation: { whatsappHref: string | null; linkAvailable: boolean } | null;
};

// One order in the admin list (client-009). Server-rendered; only the
// actions are a client component. Status is always a word, never colour alone;
// expired and cancelled are different terminal states with different styles
// (US-9). The phone is shown LTR-isolated.
export function OrderCard({ order, labels, listQuery }: { order: AdminOrderView; labels: OrderCardLabels; listQuery: string }) {
  const t = useTranslations('admin.orders');
  const phone = displayPhone(order.phone);
  const headingId = `order-${order.id}`;

  return (
    <article className="admin-order" data-status={order.status} aria-labelledby={headingId} data-testid="order-card" data-order={order.orderNumber}>
      <header className="admin-order-head">
        <h2 id={headingId} className="admin-order-number">
          {t.rich('order_label', { number: order.orderNumber, ltr: (c) => <span className="ltr admin-order-number-value">{c}</span> })}
        </h2>
        <span className={`admin-order-status admin-order-status--${order.status}`} data-testid="order-status">
          {t(`status.${order.status}`)}
        </span>
      </header>

      <p className="admin-order-when">
        {t('for_day', { weekday: labels.weekday, date: labels.date })}
        {order.timeWindow ? <span className="admin-order-sep">{t('time_window', { window: order.timeWindow })}</span> : null}
      </p>
      <p className="admin-order-meta">
        {order.fulfillment === 'pickup' ? t('pickup') : order.city ? t('delivery_to', { city: order.city }) : t('delivery')}
        {order.source === 'custom_cake' ? <span className="admin-order-tag">{t('custom_cake')}</span> : null}
      </p>

      {order.piiPurged ? (
        <p className="admin-hint">{t('pii_purged')}</p>
      ) : (
        <p className="admin-order-customer">
          {order.name ? <span className="admin-order-name">{order.name}</span> : null}
          {phone ? (
            <span>
              <span className="visually-hidden">{t('phone_label')} </span>
              <span className="ltr num" data-testid="order-phone">
                {phone}
              </span>
            </span>
          ) : (
            <span className="admin-hint">{t('no_phone')}</span>
          )}
        </p>
      )}

      {order.items.length ? (
        <ul className="admin-order-items" aria-label={t('items_label')}>
          {order.items.map((item, i) => (
            <li key={i}>{t('item_line', { quantity: item.quantity, name: item.name })}</li>
          ))}
        </ul>
      ) : null}

      <p className="admin-order-total">
        <span>{t('total')}</span>
        <PriceAmount amount={order.total} className="admin-order-amount" />
      </p>

      {labels.expiry && order.status === 'payment_pending' ? (
        <p className="admin-hint" data-testid="order-expires">
          {t('expires_at', labels.expiry)}
        </p>
      ) : null}
      {labels.expiry && order.status === 'expired' ? (
        <p className="admin-hint" data-testid="order-expired-at">
          {t('expired_at', labels.expiry)}
        </p>
      ) : null}
      {labels.checkLatePayment ? (
        <p className="admin-warn" data-testid="check-late-payment">
          {t('expired_card_hint')}
        </p>
      ) : null}

      {labels.whatsappHref ? (
        <a
          className="btn btn-secondary admin-order-wa"
          href={labels.whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('whatsapp_label', { number: order.orderNumber })}
          data-testid="order-whatsapp"
        >
          {t('whatsapp')}
        </a>
      ) : null}

      <OrderActions
        id={order.id}
        orderNumber={order.orderNumber}
        status={order.status}
        total={order.total}
        dayLabel={labels.day}
        confirmationMissing={order.confirmationMissing}
        confirmation={labels.confirmation}
        listQuery={listQuery}
      />
    </article>
  );
}
