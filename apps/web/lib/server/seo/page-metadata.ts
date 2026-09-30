import 'server-only';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { SeoKey } from '@/lib/shared/seo/public-routes';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { siteOrigin } from './site';

/**
 * Metadata for one public route: title, unique description (messages
 * seo.description.<key>), absolute canonical, Open Graph and Twitter card.
 * `robots` is only passed for a page that is noindex on purpose.
 */
export async function pageMetadata(opts: { path: string; title: string; key: SeoKey; robots?: Metadata['robots']; referrer?: Metadata['referrer'] }): Promise<Metadata> {
  const [t, site] = await Promise.all([getTranslations('seo'), getPublicSiteSettings()]);
  const description = t(`description.${opts.key}`);
  const url = `${siteOrigin()}${opts.path === '/' ? '/' : opts.path}`;
  return {
    title: opts.title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', url, title: opts.title, description, locale: 'he_IL', ...(site.business_name ? { siteName: site.business_name } : {}) },
    twitter: { card: 'summary', title: opts.title, description },
    ...(opts.robots ? { robots: opts.robots } : {}),
    ...(opts.referrer ? { referrer: opts.referrer } : {}),
  };
}
