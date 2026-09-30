// The public routes that search engines may index, with the i18n key of each
// route's description (messages: seo.description.<key>). Pure data, shared by
// app/sitemap.ts, the per-page metadata and the tests.
//
// Deliberately absent: /admin, /checkout, /order/*, /account/*, /register,
// /unsubscribe (private or per-customer), and /find-order, which is noindex
// (its result carries a capability link), so listing it in a sitemap would
// contradict its own robots meta.
export const INDEXABLE_ROUTES = [
  { path: '/', key: 'home' },
  { path: '/custom-cake', key: 'custom_cake' },
  { path: '/business', key: 'business' },
  { path: '/privacy', key: 'privacy' },
  { path: '/terms', key: 'terms' },
  { path: '/returns', key: 'returns' },
  { path: '/accessibility', key: 'accessibility' },
] as const;

export type SeoKey = (typeof INDEXABLE_ROUTES)[number]['key'] | 'find_order';

/** Path prefixes that robots.txt keeps crawlers out of, even on PROD. */
export const ROBOTS_DISALLOW = ['/admin', '/api'] as const;
