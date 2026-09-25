import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { loadCapacityDay } from '@/lib/server/capacity/admin-capacity-day';
import { capacityDayParam } from '@/lib/shared/contracts/capacity';
import { addDays, jerusalemDate } from '@/lib/shared/time/jerusalem';
import { CapacityBar } from '@/components/admin/capacity/CapacityBar';
import { CapacityDayForm } from '@/components/admin/capacity/CapacityDayForm';
import { WeeklyPatternForm } from '@/components/admin/capacity/WeeklyPatternForm';

// Admin capacity screen (client-007): one day at a time (?day=YYYY-MM-DD,
// default today in Asia/Jerusalem), its capacity built from its own orders,
// the day's oven/work minutes and closed switch, and the standing weekly
// pattern. Arrives with its data (server-rendered); only saves go through fetch.
export default async function AdminCapacityPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  await requireAdminPage();
  const t = await getTranslations('admin.capacity');
  const requested = capacityDayParam.safeParse((await searchParams).day);
  const today = jerusalemDate(new Date());
  const day = requested.success ? requested.data : today;

  const view = await loadCapacityDay(await createUserClient(), day);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const pattern = view.pattern.find((p) => p.weekday === weekday);
  const ledger = view.ledger;
  const initial = ledger ?? {
    ovenMinutesTotal: pattern?.ovenMinutesTotal ?? 0,
    workMinutesTotal: pattern?.workMinutesTotal ?? 0,
    isBlackout: pattern ? !pattern.isWorkingDay : false,
  };
  const [, month, dom] = day.split('-').map(Number) as [number, number, number];

  return (
    <>
      <div className="admin-dayhead">
        <h1 className="admin-daytitle" data-testid="day-title">
          {t('day_title', { weekday: t(`weekday.${weekday}`), date: `${dom}.${month}` })}
        </h1>
        <nav className="admin-daynav" aria-label={t('day_nav')}>
          <Link href={`/admin/capacity?day=${addDays(day, -1)}`} className="admin-round" aria-label={t('previous_day')} prefetch={false} data-testid="prev-day">
            <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
            </svg>
          </Link>
          <Link href={`/admin/capacity?day=${addDays(day, 1)}`} className="admin-round" aria-label={t('next_day')} prefetch={false} data-testid="next-day">
            <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z" />
            </svg>
          </Link>
        </nav>
      </div>
      {day !== today ? (
        <p className="admin-today-link">
          <Link href="/admin/capacity" className="admin-inline-link" prefetch={false}>
            {t('back_to_today')}
          </Link>
        </p>
      ) : null}

      <section className="admin-cap" aria-label={t('day_section')}>
        {ledger ? (
          <>
            <CapacityBar
              resource="oven"
              total={ledger.ovenMinutesTotal}
              reserved={ledger.ovenMinutesReserved}
              unpaid={ledger.ovenMinutesUnpaidReserved}
              segments={view.orders.map((o) => ({ key: o.id, minutes: o.ovenMinutes }))}
              isBlackout={ledger.isBlackout}
              orderCount={view.orders.length}
            />
            <CapacityBar
              resource="work"
              total={ledger.workMinutesTotal}
              reserved={ledger.workMinutesReserved}
              unpaid={ledger.workMinutesUnpaidReserved}
              segments={view.orders.map((o) => ({ key: o.id, minutes: o.workMinutes }))}
              isBlackout={ledger.isBlackout}
              orderCount={view.orders.length}
            />
          </>
        ) : (
          <p className="admin-warn" data-testid="day-not-set">
            {t('day_not_set')}
          </p>
        )}
        <CapacityDayForm
          key={day}
          day={day}
          initial={{ ovenMinutesTotal: initial.ovenMinutesTotal, workMinutesTotal: initial.workMinutesTotal, isBlackout: initial.isBlackout }}
          orderCount={view.orders.length}
          source={ledger?.source ?? 'none'}
          canReset={ledger?.source === 'manual' && !!pattern}
        />
      </section>

      <h2 className="admin-section-title">{t('weekly_pattern')}</h2>
      <WeeklyPatternForm pattern={view.pattern} />
    </>
  );
}
