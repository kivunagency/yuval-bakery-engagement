import { describe, expect, it } from 'vitest';
import { displayPhone, telHref, toE164, waMeHref } from '@/lib/shared/contact/links';
import { formatIls, vatLabelKey } from '@/lib/shared/price/vat';
import { EMPTY_SITE_SETTINGS, publicSiteSettings } from '@/lib/shared/contracts/site-settings';
import en from '@/messages/en.json';
import he from '@/messages/he.json';

describe('contact links (US-0b)', () => {
  it.each(['050-1234567', '0501234567', '+972501234567', '972501234567', '050 123 4567'])('mobile %s', (raw) => {
    expect(toE164(raw)).toBe('+972501234567');
    expect(telHref(raw)).toBe('tel:+972501234567');
    expect(waMeHref(raw)).toBe('https://wa.me/972501234567');
    expect(displayPhone(raw)).toBe('050-123-4567');
  });
  it('landline 03 number: tel link and 2-3-4 display', () => {
    expect(telHref('03-1234567')).toBe('tel:+97231234567');
    expect(displayPhone('03-1234567')).toBe('03-123-4567');
  });
  it.each([null, undefined, '', '12345', '0501234', '+1 212 555 0100', 'not a phone', '050123456789'])('rejects %s (no link to a guessed number)', (raw) => {
    expect(telHref(raw)).toBeNull();
    expect(waMeHref(raw)).toBeNull();
    expect(displayPhone(raw)).toBeNull();
  });
  it('prefills the WhatsApp message, URL-encoded', () => {
    expect(waMeHref('0501234567', 'order YB-7K3M9Q ok?')).toBe('https://wa.me/972501234567?text=order%20YB-7K3M9Q%20ok%3F');
  });
});

describe('price and VAT wording (compliance-spec 8)', () => {
  it('only a licensed dealer says incl. VAT; exempt and unknown say final price', () => {
    expect(vatLabelKey('licensed')).toBe('price.incl_vat');
    expect(vatLabelKey('exempt')).toBe('price.final_price');
    expect(vatLabelKey(null)).toBe('price.final_price');
    expect(vatLabelKey('garbage')).toBe('price.final_price');
  });
  it('both labels exist in English and Hebrew, and differ', () => {
    expect(en.business.price.final_price).toBe('final price');
    expect(en.business.price.incl_vat).toBe('incl. VAT');
    expect(he.business.price.final_price).not.toBe('');
    expect(he.business.price.incl_vat).not.toBe(he.business.price.final_price);
  });
  it('formats whole shekels without decimals and agorot with two', () => {
    const strip = (s: string) => s.replace(/[‎‏ ]/g, ' ').replace(/\s+/g, ' ').trim();
    expect(strip(formatIls(120))).toBe('120 ₪');
    expect(strip(formatIls(1250.5))).toBe('1,250.50 ₪');
  });
});

describe('site settings contract', () => {
  it('accepts the all-unset shape the DB returns before Yuval fills anything in', () => {
    expect(publicSiteSettings.parse(EMPTY_SITE_SETTINGS)).toEqual(EMPTY_SITE_SETTINGS);
  });
});
