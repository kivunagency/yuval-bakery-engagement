import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import '@fontsource/ibm-plex-sans-hebrew/400.css';
import '@fontsource/ibm-plex-sans-hebrew/500.css';
import '@fontsource/ibm-plex-sans-hebrew/600.css';
import '@fontsource/ibm-plex-sans-hebrew/700.css';
import '@fontsource/karantina/700.css';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('business.details');
  return { title: t('name') };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F3F3F0' },
    { media: '(prefers-color-scheme: dark)', color: '#131418' },
  ],
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
        <NextIntlClientProvider>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
