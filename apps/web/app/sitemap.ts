import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/server/seo/site';
import { INDEXABLE_ROUTES } from '@/lib/shared/seo/public-routes';

export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return INDEXABLE_ROUTES.map((r) => ({ url: r.path === '/' ? `${origin}/` : `${origin}${r.path}` }));
}
