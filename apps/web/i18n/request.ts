import { getRequestConfig } from 'next-intl/server';

// English-first i18n: keys and messages/en.json are the source of truth,
// messages/he.json holds the Hebrew the UI ships with. The UI is Hebrew-only
// for now, so the locale is fixed; no locale segment in the URL.
export const UI_LOCALE = 'he';

export default getRequestConfig(async () => ({
  locale: UI_LOCALE,
  timeZone: 'Asia/Jerusalem',
  messages: (await import(`../messages/${UI_LOCALE}.json`)).default,
}));
