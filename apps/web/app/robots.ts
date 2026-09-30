import type { MetadataRoute } from 'next';
import { serverEnv } from '@/lib/server/env';
import { siteOrigin } from '@/lib/server/seo/site';
import { robotsDisallow } from '@/lib/shared/seo/robots';

// Read per request: APP_ENV and SITE_URL are runtime settings (DEV and PROD
// are the same build). Only APP_ENV=prod allows indexing.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const prod = serverEnv().APP_ENV === 'prod';
  return {
    rules: { userAgent: '*', ...(prod ? { allow: '/', disallow: robotsDisallow('prod') } : { disallow: robotsDisallow(serverEnv().APP_ENV) }) },
    ...(prod ? { sitemap: `${siteOrigin()}/sitemap.xml` } : {}),
  };
}
