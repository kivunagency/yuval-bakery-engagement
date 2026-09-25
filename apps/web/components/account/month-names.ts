// Month names for the day/month selects, from the platform's Intl data for
// the UI locale (no Hebrew literals in code).
export function monthNames(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2000, i, 1))));
}
