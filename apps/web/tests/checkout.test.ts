import { describe, expect, it } from 'vitest';
import { createOrderRequest, checkoutErrorBody, CHECKOUT_ERRORS } from '@/lib/shared/contracts/checkout';
import { quoteCart } from '@/lib/shared/checkout/quote';
import { safePaymentLink } from '@/lib/shared/payment/links';
import { mapOrderDbError } from '@/lib/server/ordering/create-order';
import { DB_ERROR_CODES } from '@/lib/server/supabase/rpc';

const P1 = '20000000-0000-0000-0000-000000000001';
const P2 = '20000000-0000-0000-0000-000000000002';
const SLOT = '30000000-0000-0000-0000-000000000001';
const base = { items: [{ productId: P1, quantity: 2 }], day: '2026-10-01', slotId: SLOT, fulfillment: 'pickup', name: 'Dana', phone: '050-123 4567' };

describe('createOrderRequest (POST /api/orders)', () => {
  it('accepts a pickup order and normalizes the phone to E.164', () => {
    const r = createOrderRequest.parse(base);
    expect(r.phone).toBe('+972501234567');
  });
  it('never accepts an amount, a zone id or any unknown key', () => {
    for (const extra of [{ total: 1 }, { price: 1 }, { deliveryFee: 0 }, { zoneId: SLOT }]) {
      expect(createOrderRequest.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    expect(createOrderRequest.safeParse({ ...base, items: [{ productId: P1, quantity: 1, price: 0 }] }).success).toBe(false);
  });
  it('delivery needs a city and an address', () => {
    const r = createOrderRequest.safeParse({ ...base, fulfillment: 'delivery' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0]).sort()).toEqual(['address', 'city']);
    expect(createOrderRequest.safeParse({ ...base, fulfillment: 'delivery', city: 'x', address: 'y 1' }).success).toBe(true);
  });
  it('refuses bad quantities, duplicates, empty carts, landlines and long text', () => {
    for (const bad of [
      { items: [] },
      { items: [{ productId: P1, quantity: 0 }] },
      { items: [{ productId: P1, quantity: 1.5 }] },
      { items: [{ productId: P1, quantity: 21 }] },
      { items: [{ productId: P1, quantity: 1 }, { productId: P1, quantity: 2 }] },
      { phone: '03-1234567' },
      { name: 'x'.repeat(61) },
      { notes: 'x'.repeat(501) },
      { day: '2026-02-30' },
    ]) expect(createOrderRequest.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('DB refusals map to what the screen needs', () => {
  it('capacity, day and lead time send the customer back to the day picker', () => {
    for (const c of ['capacity_reservation_failed', 'day_unavailable', 'unpaid_holds_capacity_cap_exceeded', 'lead_time_not_met'] as const) {
      expect(mapOrderDbError(c).pickAnotherDay, c).toBe(true);
    }
    expect(mapOrderDbError('single_order_capacity_cap_exceeded')).toEqual({ error: 'order_too_big' });
    expect(mapOrderDbError('rate_limit_ip_exceeded')).toEqual({ error: 'too_many_attempts' });
    expect(mapOrderDbError('unknown')).toEqual({ error: 'server_error' });
  });
  it('every mapped code is a known DB code and every answer is a known checkout error', () => {
    for (const c of DB_ERROR_CODES) expect(CHECKOUT_ERRORS).toContain(mapOrderDbError(c).error);
    expect(checkoutErrorBody.safeParse({ error: 'day_full', pickAnotherDay: true }).success).toBe(true);
  });
});

describe('quoteCart (the preview before submit)', () => {
  it('sums lines and the delivery fee, and reports products no longer on sale', () => {
    const products = new Map([[P1, { name: 'a', price: 14 }], [P2, { name: 'b', price: 12.5 }]]);
    const q = quoteCart([{ productId: P1, quantity: 3 }, { productId: P2, quantity: 1 }, { productId: SLOT, quantity: 1 }], products, 25);
    expect(q).toMatchObject({ subtotal: 54.5, deliveryFee: 25, total: 79.5, missing: [SLOT] });
  });
});

describe('safePaymentLink (SEC-009)', () => {
  it('passes an https link on the allowlist, refuses everything else', () => {
    expect(safePaymentLink('bit', 'https://www.bitpay.co.il/app/me/abc')).toBe('https://www.bitpay.co.il/app/me/abc');
    expect(safePaymentLink('paybox', 'https://payboxapp.page.link/xyz')).toBe('https://payboxapp.page.link/xyz');
    for (const bad of [null, '', 'not a url', 'http://www.bitpay.co.il/x', 'https://bitpay.co.il.evil.test/x', 'https://evil.test/?u=bitpay.co.il', 'javascript:alert(1)', 'https://user@www.bitpay.co.il/x', 'https://payboxapp.page.link/x']) {
      expect(safePaymentLink('bit', bad), String(bad)).toBeNull();
    }
  });
});
