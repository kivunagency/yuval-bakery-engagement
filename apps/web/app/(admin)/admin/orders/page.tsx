import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { HOLDS_ALERT_PCT, loadAdminOrders, ORDER_LIST_LIMIT, RECENT_EXPIRY_HOURS } from '@/lib/server/ordering/admin-orders-list';
import { orderListDay, orderListFilter } from '@/lib/shared/contracts/admin-orders';
import { waMeHref } from '@/lib/shared/contact/links';
import { serverEnv } from '@/lib/server/env';
import { confirmationLinkToken, confirmationPath } from '@/lib/server/confirmation/link';
import { BUSINESS_TZ, jerusalemDate } from '@/lib/shared/time/jerusalem';
import { ORDER_STATUSES } from '@/lib/shared/types';
import { shortDate } from '@/components/day-state/format';
import { formatIls } from '@/lib/shared/price/vat';
import { OrderCard, type OrderCardLabels } from '@/components/admin/orders/OrderCard';
import { ReleaseUnpaid } from '@/components/admin/orders/ReleaseUnpaid';

const DONE = ['paid', 'cancelled', 'fulfilled', 'released', 'confirmation_sent'] as const;
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Jerusalem "1.10" (no leading zeros, design-tokens.md) and "14:30" of an instant. */
function jerusalemWhen(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  return { date: shortDate(jerusalemDate(at)), time: timeFmt.format(at) };
}

// Admin orders screen (client-009): orders by status (?status=, default
// waiting for payment), each with its actions and a prefilled WhatsApp
// message; per-day unpaid holds with "release all unpaid" (SEC-006); and the
// expired view's note about late payments (blindspot-005). Arrives with its
// data (server-rendered as the admin's JWT); only actions go through fetch.
// Custom-cake requests have their own screen under this tab (client-008).
export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; day?: string; done?: string; order?: string; count?: string }>;
}) {
  await requireAdminPage();
  const [t, tc, tw, params, supabase] = await Promise.all([
    getTranslations('admin.orders'),
    getTranslations('confirmation.admin'),
    getTranslations('admin.capacity.weekday'),
    searchParams,
    createUserClient(),
  ]);
  const status = orderListFilter.parse(params.status);
  const day = orderListDay.parse(params.day ?? null);
  const now = new Date();
  const today = jerusalemDate(now);
  const view = await loadAdminOrders(supabase, { status, day, today, now });
  const listHref = (s: string, d: string | null = day) => `/admin/orders?${new URLSearchParams(d ? { status: s, day: d } : { status: s }).toString()}`;
  const listQuery = new URLSearchParams(day ? { status, day } : { status }).toString();

  const weekdayOf = (day: string) => tw(String(new Date(`${day}T12:00:00Z`).getUTCDay()));
  const dayLabel = (day: string) => `${weekdayOf(day)} ${shortDate(day)}`;
  const siteUrl = serverEnv().SITE_URL.replace(/\/+$/, '');
  // US-0c: the confirmation link is derived from the order id, so building it
  // here writes nothing; the PDF is issued when it is first opened or when
  // Yuval presses "I sent it". Fixed template, no customer text (SEC-024).
  const confirmationFor = (o: (typeof view.orders)[number]): OrderCardLabels['confirmation'] => {
    if (o.status !== 'paid' || !o.confirmationMissing || o.piiPurged) return null;
    try {
      const url = `${siteUrl}${confirmationPath(confirmationLinkToken(o.id))}`;
      return { whatsappHref: waMeHref(o.phone, tc('whatsapp_text', { number: o.orderNumber, url })), linkAvailable: true };
    } catch (e) {
      console.error('confirmation link unavailable', e instanceof Error ? e.message : 'unknown');
      return { whatsappHref: null, linkAvailable: false };
    }
  };
  const labelsFor = (o: (typeof view.orders)[number]): OrderCardLabels => {
    const whenIso = o.status === 'expired' ? o.expiredAt : o.status === 'payment_pending' ? o.expiresAt : null;
    // SEC-024: fixed template from the server, no customer free text (not even the name), URL-encoded by waMeHref.
    const text = t(`whatsapp_text.${o.status}`, { number: o.orderNumber, date: shortDate(o.deliveryDate), total: formatIls(o.total) });
    return {
      weekday: weekdayOf(o.deliveryDate),
      date: shortDate(o.deliveryDate),
      day: dayLabel(o.deliveryDate),
      whatsappHref: o.piiPurged ? null : waMeHref(o.phone, text),
      expiry: whenIso ? jerusalemWhen(whenIso) : null,
      checkLatePayment: o.status === 'expired' && o.deliveryDate >= today,
      confirmation: confirmationFor(o),
    };
  };

  const done = DONE.find((d) => d === params.done);
  const doneOrder = params.order && /^[A-Z0-9-]{1,16}$/.test(params.order) ? params.order : null;
  const doneCount = Number.parseInt(params.count ?? '', 10);
  const ltr = (chunks: React.ReactNode) => <span className="ltr num">{chunks}</span>;

  return (
    <>
      <div className="admin-orders-head">
        <h1 className="admin-page-title">{t('title')}</h1>
        <Link href="/admin/custom-cakes" className="admin-inline-link" prefetch={false}>
          {t('custom_cakes_link')}
        </Link>
      </div>

      {done === 'released' && Number.isFinite(doneCount) ? (
        <p className="admin-ok" role="status" data-testid="orders-done">
          {t('done.released', { count: doneCount })}
        </p>
      ) : done === 'confirmation_sent' && doneOrder ? (
        <p className="admin-ok" role="status" data-testid="orders-done">
          {tc.rich('done', { number: doneOrder, ltr })}
        </p>
      ) : done && done !== 'released' && doneOrder ? (
        <p className="admin-ok" role="status" data-testid="orders-done">
          {t.rich(`done.${done}`, { number: doneOrder, ltr })}
        </p>
      ) : null}

      <nav className="admin-filter" aria-label={t('filter_label')}>
        {ORDER_STATUSES.map((s) => (
          <Link
            key={s}
            href={listHref(s)}
            prefetch={false}
            aria-current={s === status ? 'page' : undefined}
            className={`admin-filter-chip admin-filter-chip--${s}`}
            data-testid={`filter-${s}`}
          >
            <span>{t(`filter.${s}`)}</span>
            <span className="num admin-filter-count">{view.counts[s]}</span>
          </Link>
        ))}
      </nav>

      {day ? (
        <p className="admin-orders-day" data-testid="day-filter">
          <span>{t('day_filter', { day: dayLabel(day) })}</span>{' '}
          <Link href={listHref(status, null)} className="admin-inline-link" prefetch={false}>
            {t('all_days')}
          </Link>
        </p>
      ) : null}

      {status !== 'expired' && view.recentlyExpired > 0 ? (
        <div className="admin-warn admin-orders-banner" data-testid="recent-expired">
          <p>{t('recent_expired', { count: view.recentlyExpired, hours: RECENT_EXPIRY_HOURS })}</p>
          <Link href="/admin/orders?status=expired" className="admin-inline-link" prefetch={false}>
            {t('recent_expired_link')}
          </Link>
        </div>
      ) : null}

      {status === 'expired' ? (
        <section className="admin-note" aria-labelledby="expired-note" data-testid="expired-note">
          <h2 id="expired-note" className="admin-note-title">
            {t('expired_note_title')}
          </h2>
          <p>{t('expired_note')}</p>
        </section>
      ) : null}

      {status === 'payment_pending' && view.unpaidDays.length > 0 ? (
        <section className="admin-holds" aria-labelledby="holds-title" data-testid="unpaid-holds">
          <h2 id="holds-title" className="admin-holds-title">
            {t('holds_title')}
          </h2>
          {view.unpaidCapPct !== null ? <p className="admin-hint">{t('holds_intro', { cap: view.unpaidCapPct })}</p> : null}
          <ul className="admin-holds-list">
            {view.unpaidDays.map((d) => {
              const high = d.unpaidPct >= HOLDS_ALERT_PCT;
              return (
                <li key={d.day} className="admin-holds-day" data-high={high || undefined} data-testid={`holds-${d.day}`}>
                  <p className="admin-holds-name">{t('holds_day', { weekday: weekdayOf(d.day), date: shortDate(d.day) })}</p>
                  <p className="admin-holds-line">{t('holds_line', { pct: d.unpaidPct, count: d.unpaidOrders })}</p>
                  {high ? <p className="admin-warn">{t('holds_high')}</p> : null}
                  {d.day !== day ? (
                    <Link href={listHref('payment_pending', d.day)} className="admin-inline-link admin-holds-link" prefetch={false}>
                      {t('holds_show_day')}
                    </Link>
                  ) : null}
                  {d.unpaidOrders > 0 ? <ReleaseUnpaid day={d.day} dayLabel={dayLabel(d.day)} count={d.unpaidOrders} /> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-label={t('list_label', { status: t(`filter.${status}`) })}>
        {view.orders.length === 0 ? (
          <p className="admin-hint" data-testid="orders-empty">
            {t('empty')}
          </p>
        ) : (
          <div className="admin-order-list">
            {view.orders.map((o) => (
              <OrderCard key={o.id} order={o} labels={labelsFor(o)} listQuery={listQuery} />
            ))}
          </div>
        )}
        {view.orders.length >= ORDER_LIST_LIMIT ? <p className="admin-hint">{t('list_limited', { limit: ORDER_LIST_LIMIT })}</p> : null}
      </section>
    </>
  );
}
