import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { visualString } from '@/lib/server/confirmation/bidi-runs';
import { confirmationLinkToken, hashLinkToken, linkMatchesStored, orderIdFromLinkToken } from '@/lib/server/confirmation/link';
import { renderConfirmationPdf } from '@/lib/server/confirmation/pdf';
import { buildConfirmationDocument, confirmationFilename } from '@/lib/server/confirmation/content';
import { EMPTY_SITE_SETTINGS } from '@/lib/shared/contracts/site-settings';
import type { PublicOrder } from '@/lib/server/ordering/order-by-token';
import he from '@/messages/he.json';

// US-0c: the confirmation PDF's line order, its link token and its renderer.
// The rendered PDF itself is looked at as PNG in qa/regression.confirmation.spec.js.

// What a reader sees, left to right, for an RTL line (UAX #9, as a browser
// shows it). Hebrew comes from messages/he.json (no Hebrew literals in code).
const W = he.confirmation.pdf.title; // two Hebrew words
const B = he.business.labels.name; // two Hebrew words
const UNIT = he.payment.line.split(' ').pop()!; // the units word after the quantity
const R = (s: string) => [...s].reverse().join('');

describe('visualString (UAX #9 for the PDF)', () => {
  it.each([
    [`${W} A7K-29QX`, `A7K-29QX ${R(W)}`],
    [`${W}: 145.50 ₪`, `₪ 145.50 :${R(W)}`],
    [`${W} (${B})`, `(${R(B)}) ${R(W)}`],
    [`[${B}]`, `[${R(B)}]`],
    [`${W}: ⁦050-123-4567⁩`, `050-123-4567 :${R(W)}`],
    // W7: a number after Latin joins it; this is why names are isolated (lib/shared/text/bidi.ts).
    [`Brownie, 3 ${UNIT}`, `${R(UNIT)} Brownie, 3`],
    [`⁨Brownie⁩, 3 ${UNIT}`, `${R(UNIT)} 3 ,Brownie`],
  ])('%s', (logical, visual) => {
    expect(visualString(logical)).toBe(visual);
  });

  it('drops bidi controls (no glyph in the font) but keeps every other character', () => {
    const out = visualString(`${W} ⁦A7K⁩ ‏ok`);
    expect(out).not.toMatch(/[‎‏⁦-⁩]/);
    expect([...out].sort().join('')).toBe([...`${W} A7K ok`].sort().join(''));
  });
});

describe('confirmation link token', () => {
  const id = '0b0f1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CONFIRMATION_LINK_SECRET;
    process.env.CONFIRMATION_LINK_SECRET = 'unit-test-secret-unit-test-secret-0123456789';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CONFIRMATION_LINK_SECRET;
    else process.env.CONFIRMATION_LINK_SECRET = saved;
  });

  it('is "<order id>.<43-char mac>", stable, and round-trips to the id', () => {
    const token = confirmationLinkToken(id);
    expect(token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(confirmationLinkToken(id)).toBe(token);
    expect(orderIdFromLinkToken(token)).toBe(id);
    expect(linkMatchesStored(token, hashLinkToken(token))).toBe(true);
  });

  it('refuses a tampered mac, another id with the same mac, the id alone, garbage', () => {
    const token = confirmationLinkToken(id);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(orderIdFromLinkToken(flipped)).toBeNull();
    expect(orderIdFromLinkToken(`1${token.slice(1)}`)).toBeNull();
    expect(orderIdFromLinkToken(id)).toBeNull();
    expect(orderIdFromLinkToken('A7K29QX')).toBeNull();
    expect(orderIdFromLinkToken('')).toBeNull();
  });

  it('a changed secret gives a different link, which never matches the stored hash', () => {
    const before = confirmationLinkToken(id);
    process.env.CONFIRMATION_LINK_SECRET = 'another-secret-another-secret-0123456789';
    expect(orderIdFromLinkToken(before)).toBeNull();
    expect(linkMatchesStored(confirmationLinkToken(id), hashLinkToken(before))).toBe(false);
  });

  it('without a secret (or a short one) nothing is built', () => {
    process.env.CONFIRMATION_LINK_SECRET = 'short';
    expect(() => confirmationLinkToken(id)).toThrow('confirmation_link_secret_missing');
  });
});

describe('confirmation document', () => {
  const order: PublicOrder = {
    id: '0b0f1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    createdAt: '2026-09-26T08:00:00.000Z',
    view: {
      orderNumber: 'A7K29QX',
      status: 'payment_pending',
      source: 'standard',
      fulfillment: 'delivery',
      day: '2026-10-14',
      slotStart: '10:00',
      slotEnd: '12:00',
      city: 'Tel Aviv',
      subtotal: 120,
      deliveryFee: 25.5,
      total: 145.5,
      paymentPendingExpiresAt: null,
      items: [{ name: 'Brownie', quantity: 3, unitPrice: 40, lineTotal: 120 }],
    },
  };

  it('carries order, items, total, payment, cancellation and business placeholders; no customer identity fields exist to leak', () => {
    const doc = buildConfirmationDocument(order, EMPTY_SITE_SETTINGS, 'https://example.test');
    const text = doc.blocks.map((b) => ('text' in b ? b.text : 'label' in b ? `${b.label} ${b.value}` : '')).join('\n');
    expect(text).toContain('A7K29QX');
    expect(text).toContain('Brownie');
    expect(text).toContain('145.50');
    expect(text).toContain(he.business.details.name);
    expect(text).toContain(he.business.details.registration_number);
    expect(text).toContain('https://example.test/business');
    expect(text).toContain(he.returns_policy.exemption_notice.catalog);
  });

  it('custom cake wording for a custom cake order', () => {
    const doc = buildConfirmationDocument({ ...order, view: { ...order.view, source: 'custom_cake' } }, EMPTY_SITE_SETTINGS, 'https://example.test');
    expect(doc.blocks.some((b) => b.kind === 'text' && b.text === he.returns_policy.exemption_notice.custom_cake)).toBe(true);
  });

  it('renders a PDF with the font embedded, and the same content gives the same bytes', async () => {
    const doc = buildConfirmationDocument(order, EMPTY_SITE_SETTINGS, 'https://example.test');
    const a = await renderConfirmationPdf(doc);
    const b = await renderConfirmationPdf(doc);
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.toString('latin1')).toMatch(/\/FontFile2/);
    expect(a.toString('latin1')).toMatch(/IBMPlexSansHebrew/);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('filename is the order number only', () => {
    expect(confirmationFilename('A7K29QX')).toBe('order-A7K29QX.pdf');
    expect(confirmationFilename('A7"/..\\K')).toBe('order-A7K.pdf');
  });
});
