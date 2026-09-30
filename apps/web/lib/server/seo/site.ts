import 'server-only';
import { serverEnv } from '@/lib/server/env';

/** Public origin from SITE_URL, without a trailing slash. */
export function siteOrigin(): string {
  return serverEnv().SITE_URL.replace(/\/+$/, '');
}

export function isIndexable(): boolean {
  return serverEnv().APP_ENV === 'prod';
}
