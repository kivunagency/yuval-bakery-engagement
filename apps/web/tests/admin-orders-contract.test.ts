import { describe, expect, it } from 'vitest';
import { adminOrdersApiError, orderActionBody, orderIdParam } from '@/lib/shared/contracts/admin-orders';
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
