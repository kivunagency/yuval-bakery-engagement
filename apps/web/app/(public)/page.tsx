import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getCatalog } from '@/lib/server/catalog/get-catalog';
import { defaultDayWindow, getDayAvailability } from '@/lib/server/capacity/day-availability';
import { isoDate } from '@/lib/shared/contracts/primitives';
import { CatalogScreen } from '@/components/catalog/CatalogScreen';
import { isSelectableDay } from '@/components/day-state/DayState';

// Catalog at `/` (client-001): the Instagram bio link lands here. Server
// component: the catalog and the day strip are fetched here, in parallel, and
// the first frame is complete (Rule 31). The client only reacts to the day the
// customer picks and to the cart.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('catalog.title')} | ${t('business.details.name')}` };
}

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [t, params] = await Promise.all([getTranslations('business.details'), searchParams]);
  const range = defaultDayWindow();
  const [catalog, availability] = await Promise.all([getCatalog(), getDayAvailability(range.from, range.to)]);

  // ?day= keeps a shared or reloaded link on the same day, only if that day
  // is still selectable (the DB's state, not ours).
  const requested = isoDate.safeParse(params.day);
  const initialDay =
    requested.success && availability.days.some((d) => d.day === requested.data && isSelectableDay(d.state))
      ? requested.data
      : null;

  return <CatalogScreen businessName={t('name')} catalog={catalog} availability={availability} initialDay={initialDay} />;
}
