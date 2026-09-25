import { describe, expect, it } from 'vitest';
import { adminOrdersApiError, orderActionBody, orderIdParam, orderListDay, orderListFilter, releaseUnpaidBody } from '@/lib/shared/contracts/admin-orders';
import { parseOrderAction } from '@/lib/server/ordering/admin-order-route';

const ID = '5f0c7c2e-8a4b-4c1e-9d3a-2b6f1e0a9c11';
const req = (body?: string) => new Request('http://localhost/api/admin/orders/x/mark-paid', { method: 'POST', body });

describe('admin order actions contract (api-004)', () => {
  it('the id is a UUID', () => {
    expect(orderIdParam.safeParse(ID).success).toBe(true);
    for (const bad of ['', 'A248-XYZ', '1', `${ID}x`]) expect(orderIdParam.safeParse(bad).success, bad).toBe(false);
  });

  it('the body carries nothing: an amount or an actor id from the client is rejected (SEC-008, admin from auth.uid())', () => {
    expect(orderActionBody.safeParse({}).success).toBe(true);
    for (const bad of [{ amount: 100 }, { adminId: ID }, { status: 'paid' }, [], 'x']) expect(orderActionBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('parseOrderAction accepts no body or {}, nothing else', async () => {
    expect(await parseOrderAction(req(), Promise.resolve({ id: ID }))).toBe(ID);
    expect(await parseOrderAction(req('{}'), Promise.resolve({ id: ID }))).toBe(ID);
    expect(await parseOrderAction(req('  '), Promise.resolve({ id: ID }))).toBe(ID);
    expect(await parseOrderAction(req('not json'), Promise.resolve({ id: ID }))).toBeNull();
    expect(await parseOrderAction(req('{"amount":1}'), Promise.resolve({ id: ID }))).toBeNull();
    expect(await parseOrderAction(req('{}'), Promise.resolve({ id: 'nope' }))).toBeNull();
  });

  it('error body: a known code, and the current status only as an order status', () => {
    expect(adminOrdersApiError.parse({ error: 'invalid_transition', status: 'expired' })).toEqual({ error: 'invalid_transition', status: 'expired' });
    expect(adminOrdersApiError.safeParse({ error: 'teapot' }).success).toBe(false);
    expect(adminOrdersApiError.safeParse({ error: 'invalid_transition', status: 'lost' }).success).toBe(false);
  });
});

describe('orders screen and release-unpaid contract (client-009)', () => {
  it('release-unpaid takes exactly one real date', () => {
    expect(releaseUnpaidBody.parse({ day: '2026-10-01' })).toEqual({ day: '2026-10-01' });
    for (const bad of [{}, { day: '2026-02-30' }, { day: '1.10' }, { day: '2026-10-01', status: 'paid' }, { day: '2026-10-01', orderIds: [ID] }])
      expect(releaseUnpaidBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('status filter falls back to waiting for payment; the day filter to all days', () => {
    expect(orderListFilter.parse('expired')).toBe('expired');
    for (const v of [undefined, '', 'lost', 'PAID']) expect(orderListFilter.parse(v)).toBe('payment_pending');
    expect(orderListDay.parse('2026-10-01')).toBe('2026-10-01');
    for (const v of [null, '2026-13-01', 'today', "2026-10-01' or 1=1"]) expect(orderListDay.parse(v)).toBeNull();
  });
});
