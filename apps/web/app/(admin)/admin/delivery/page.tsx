import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { generateDeliveryList } from '@/lib/server/delivery/delivery-list';
import { capacityDayParam } from '@/lib/shared/contracts/capacity';
import { addDays, jerusalemDate } from '@/lib/shared/time/jerusalem';
import { displayPhone, telHref } from '@/lib/shared/contact/links';
import { PrintButton } from '@/components/admin/delivery/PrintButton';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Delivery list for one day (client-011, US-7), for Yuval to print or save as
// PDF and send to the courier herself (MVP: no link the courier opens,
// SEC-016; phase2-005 is the tokenized view). Built on every render by
// generateDeliveryList, which also writes the audit row (SEC-017). The print
// stylesheet drops the admin chrome and repeats the "delete at the end of the
// day" line at the foot of every printed page.
export default async function AdminDeliveryListPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  await requireAdminPage();
  const t = await getTranslations('admin.delivery_list');
  const tDays = await getTranslations('admin.capacity.weekday');
  const requested = capacityDayParam.safeParse((await searchParams).day);
  const day = requested.success ? requested.data : jerusalemDate(new Date());

  const result = await generateDeliveryList(await createUserClient(), { date: day });
  if (!result.ok) {
    if (result.status === 400) notFound();
    throw new Error('delivery_list_failed');
  }
  const list = result.value;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const [, month, dom] = day.split('-').map(Number) as [number, number, number];

  return (
    <div className="dl">
      <div className="admin-dayhead">
        <h1 className="admin-daytitle" data-testid="delivery-title">
          {t('day_title', { weekday: tDays(String(weekday)), date: `${dom}.${month}` })}
        </h1>
        <nav className="admin-daynav dl-noprint" aria-label={t('day_nav')}>
          <Link href={`/admin/delivery?day=${addDays(day, -1)}`} className="admin-round" aria-label={t('previous_day')} prefetch={false} data-testid="prev-day">
            <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
            </svg>
          </Link>
          <Link href={`/admin/delivery?day=${addDays(day, 1)}`} className="admin-round" aria-label={t('next_day')} prefetch={false} data-testid="next-day">
            <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z" />
            </svg>
          </Link>
        </nav>
      </div>
      {list.stops.length > 0 ? (
        <p className="dl-count" data-testid="delivery-count">
          {t('stop_count', { count: list.stops.length })}
        </p>
      ) : null}

      {list.pendingCount > 0 ? (
        <p className="admin-warn dl-noprint" data-testid="delivery-pending">
          {t('pending_note', { count: list.pendingCount })}
        </p>
      ) : null}

      {list.stops.length > 0 ? (
        <div className="dl-noprint dl-actions">
          <PrintButton label={t('print')} />
          <p className="admin-hint" data-testid="delivery-share">
            {t('share')}
          </p>
        </div>
      ) : (
        <p className="admin-lead" data-testid="delivery-empty">
          {t('empty')}
        </p>
      )}

      <ol className="dl-stops" aria-label={t('list_label')}>
        {list.stops.map((s, i) => {
          const tel = telHref(s.phone);
          const shown = displayPhone(s.phone) ?? s.phone;
          return (
            <li key={i} className="dl-stop" data-testid="delivery-stop">
              <div className="dl-stop-h">
                <span className="dl-num num" aria-hidden="true">
                  {i + 1}
                </span>
                <h2 className="dl-name">
                  <bdi>{s.name}</bdi>
                </h2>
                <span className="dl-window" data-testid="stop-window">
                  {s.timeWindow ? <bdi className="num">{s.timeWindow}</bdi> : t('no_window')}
                </span>
              </div>
              <p className="dl-line">
                <span className="dl-label">{t('address')}</span> <bdi>{s.address}</bdi>, <bdi>{s.city}</bdi>
              </p>
              <p className="dl-line">
                <span className="dl-label">{t('phone')}</span>{' '}
                {tel ? (
                  <a href={tel} className="dl-phone ltr num" data-testid="stop-phone">
                    {shown}
                  </a>
                ) : (
                  <span className="ltr num" data-testid="stop-phone">
                    {shown}
                  </span>
                )}
              </p>
              {s.notes ? (
                <p className="dl-line">
                  <span className="dl-label">{t('notes')}</span> <bdi>{s.notes}</bdi>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {list.stops.length > 0 ? (
        <p className="dl-footer" data-testid="delivery-footer">
          {t('pii_footer')}
        </p>
      ) : null}
    </div>
  );
}
