import type { MetadataRoute } from 'next';
import { getTranslations } from 'next-intl/server';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';

// Web app manifest (blindspot-001). iOS delivers web push only to a site the
// user added to the home screen AS A WEB APP (iOS 16.4+), which needs a
// manifest with display "standalone". No start_url on purpose: it then
// defaults to the page where "Add to Home Screen" was pressed, so Yuval's
// icon opens the admin and a customer's opens the catalog.
// Icons: none yet (brand assets pending Yuval); iOS falls back to a page snapshot.
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations('business.details');
  const settings = await getPublicSiteSettings();
  const name = settings.business_name ?? t('name');
  return {
    name,
    short_name: name,
    display: 'standalone',
    lang: 'he',
    dir: 'rtl',
    background_color: '#f3f3f0',
    theme_color: '#f3f3f0',
  };
}
