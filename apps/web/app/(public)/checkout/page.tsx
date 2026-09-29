import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getCatalog } from '@/lib/server/catalog/get-catalog';
import { defaultDayWindow, getDayAvailability } from '@/lib/server/capacity/day-availability';
import { getPublicZones } from '@/lib/server/delivery/public-zones';
import { getActiveTimeSlots } from '@/lib/server/ordering/time-slots';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { readFeatures } from '@/lib/server/features';

// Checkout (client-003). Server component: products and prices, day states,
// delivery zones, time slots and business details are all read here, so the
// first frame is complete (Rule 31). The cart itself lives in the browser
// (sessionStorage, client-001), so the lines are matched to these products on
// the client. After render the client fetches only fresh day states, and only
// when the DB said the chosen day is gone.

export async function generateMetadata(): Promise<Metadata> {
  const [t, site] = await Promise.all([getTranslations(), getPublicSiteSettings()]);
  return { title: `${t('checkout.title')} | ${site.business_name ?? t('business.details.name')}` };
}

export default async function CheckoutPage() {
  const range = defaultDayWindow();
  const [catalog, availability, zones, slots, settings] = await Promise.all([
    getCatalog(),
    getDayAvailability(range.from, range.to),
    getPublicZones(),
    getActiveTimeSlots(),
    getPublicSiteSettings(),
  ]);

  return (
    <CheckoutForm
      products={catalog.products.map((p) => ({ id: p.id, name: p.name, price: p.price, isAvailable: p.isAvailable }))}
      days={availability.days.map((d) => ({ day: d.day, state: d.state }))}
      range={range}
      zones={zones.zones}
      slots={slots}
      settings={settings}
      now={new Date().toISOString()}
      collectEmail={readFeatures().customerEmail}
    />
  );
}
