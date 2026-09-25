import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { CancellationExemptionNotice, NotesFieldHint, PrivacyNoticeAtCollection } from '@/components/compliance';
import { ContactBlock } from '@/components/contact-block';
import { PriceWithVat } from '@/components/price';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';

// Server-render the reusable components with the English messages, so the
// contract other screens rely on (props -> content) is checked without a
// browser. Hebrew rendering is checked in qa/regression.compliance.spec.js.
const render = (el: React.ReactElement) =>
  // children as a prop: the provider's props type requires it (a .ts file, no JSX here).
  // eslint-disable-next-line react/no-children-prop
  renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: 'en', messages: en, timeZone: 'Asia/Jerusalem', children: el }));

describe('PrivacyNoticeAtCollection', () => {
  it.each(['checkout', 'registration', 'custom_cake'] as const)('%s: names the courier, links the full notice, shows the version, no checkbox', (context) => {
    const html = render(createElement(PrivacyNoticeAtCollection, { context, businessName: null }));
    expect(html).toContain("business&#x27;s courier");
    expect(html).toContain('[Business name]');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain(TEXT_VERSIONS.privacy);
    expect(html).not.toContain('checkbox');
    expect(html.includes('Inspiration photos')).toBe(context === 'custom_cake');
    expect(html.includes('separate box')).toBe(context === 'registration');
  });
  it('uses the business name once set', () => {
    expect(render(createElement(PrivacyNoticeAtCollection, { context: 'checkout', businessName: 'Test Bakery' }))).toContain('Test Bakery uses');
  });
  it('notes hint has the id the field points at', () => {
    expect(render(createElement(NotesFieldHint, { id: 'notes-hint' }))).toContain('id="notes-hint"');
  });
});

describe('CancellationExemptionNotice', () => {
  it('catalog and custom cake wording differ; both keep defect rights and the version', () => {
    const cat = render(createElement(CancellationExemptionNotice, { kind: 'catalog' }));
    const cake = render(createElement(CancellationExemptionNotice, { kind: 'custom_cake' }));
    expect(cat).toContain('Fresh food product');
    expect(cake).toContain('Made especially for you');
    for (const html of [cat, cake]) {
      expect(html).toContain('defective');
      expect(html).toContain(TEXT_VERSIONS.cancellation);
    }
  });
});

describe('ContactBlock', () => {
  it('prefills the WhatsApp message with the order number on an order page', () => {
    const html = render(createElement(ContactBlock, { phone: '0501234567', whatsapp: '0501234567', orderNumber: 'A7K3' }));
    expect(html).toContain('href="tel:+972501234567"');
    expect(html).toContain('href="https://wa.me/972501234567?text=Hi%2C%20I%20have%20a%20question%20about%20order%20A7K3"');
  });
  it('unset numbers: placeholders, no links', () => {
    const html = render(createElement(ContactBlock, { phone: null, whatsapp: null }));
    expect(html).not.toContain('href=');
    expect(html).toContain('[Business phone]');
  });
});

describe('PriceWithVat', () => {
  it('exempt says final price, licensed says incl. VAT', () => {
    expect(render(createElement(PriceWithVat, { amount: 120, vatStatus: 'exempt' }))).toContain('final price');
    expect(render(createElement(PriceWithVat, { amount: 120, vatStatus: 'licensed' }))).toContain('incl. VAT');
  });
});
