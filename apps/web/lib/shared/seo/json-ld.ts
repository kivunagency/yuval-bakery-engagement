import type { PublicSiteSettings } from '@/lib/shared/contracts/site-settings';

const clean = (v: string | null): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * schema.org Bakery (a LocalBusiness subtype) from the business settings.
 * Every value comes from the settings; a field that is unset is omitted, and
 * with no business name there is no entity at all (never a placeholder or an
 * invented value). Returns null in that case.
 */
export function bakeryJsonLd(site: PublicSiteSettings, origin: string): Record<string, unknown> | null {
  const name = clean(site.business_name);
  if (!name) return null;
  const phone = clean(site.business_phone);
  const email = clean(site.business_email);
  const address = clean(site.business_address);
  return {
    '@context': 'https://schema.org',
    '@type': 'Bakery',
    '@id': `${origin}/#bakery`,
    name,
    url: `${origin}/`,
    ...(phone ? { telephone: phone } : {}),
    ...(email ? { email } : {}),
    ...(address ? { address: { '@type': 'PostalAddress', streetAddress: address, addressCountry: 'IL' } } : {}),
  };
}

/** JSON for an inline script: `<` is escaped so data can never close the tag. */
export function jsonLdScriptText(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
