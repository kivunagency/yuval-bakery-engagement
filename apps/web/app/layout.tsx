import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import '@fontsource/ibm-plex-sans-hebrew/400.css';
import '@fontsource/ibm-plex-sans-hebrew/500.css';
import '@fontsource/ibm-plex-sans-hebrew/600.css';
import '@fontsource/ibm-plex-sans-hebrew/700.css';
import '@fontsource/karantina/700.css';
import './globals.css';
import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';

export async function generateMetadata(): Promise<Metadata> {
  const [t, site] = await Promise.all([getTranslations('business.details'), getPublicSiteSettings()]);
  return { title: site.business_name ?? t('name') };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#F3F3F0',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce makes every page render per request, which the CSP
  // nonce requires (a static page would carry no nonce and its scripts would
  // be blocked).
  await headers();
  const locale = await getLocale();
  const t = await getTranslations('app');

  return (
    <html lang={locale} dir="rtl">
      <body>
        <a className="skip-link" href="#main">
          {t('skip_to_content')}
        </a>
        <ScopedIntlProvider scope="public">{children}</ScopedIntlProvider>
      </body>
    </html>
  );
}
