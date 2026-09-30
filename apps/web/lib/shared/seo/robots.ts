import { ROBOTS_DISALLOW } from './public-routes';

/** Only APP_ENV=prod may be indexed; local and dev are never crawled. */
export function robotsDisallow(appEnv: 'local' | 'dev' | 'prod'): string[] {
  return appEnv === 'prod' ? [...ROBOTS_DISALLOW] : ['/'];
}
