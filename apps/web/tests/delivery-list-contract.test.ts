import { describe, expect, it } from 'vitest';
import { deliveryListQuery, deliveryListRow, redactDeliveryListForAgent, toDeliveryList } from '@/lib/shared/contracts/delivery-list';

const row = {
  day: '2027-03-04',
  stops: [
    { name: 'Dana', phone: '+972501234567', address: 'Herzl 1', city: 'Ramat Gan', time_window: '10:00-12:00', notes: 'Floor 2' },
    { name: 'Avi', phone: '+972521234567', address: 'Weizmann 5', city: 'Ramat Gan', time_window: null, notes: null },
    { name: 'Noa', phone: '+972541234567', address: 'Hanasi 3', city: 'Haifa', time_window: null, notes: null },
  ],
  pending_count: 2,
};

describe('delivery list contract (api-008)', () => {
  it('query: a real date only, no other keys', () => {
    expect(deliveryListQuery.safeParse({ date: '2027-03-04' }).success).toBe(true);
    for (const q of [{}, { date: '2027-02-30' }, { date: 'today' }, { date: '2027-03-04', status: 'all' }]) {
      expect(deliveryListQuery.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
  });

  it('a DB row with any extra field (email, price, items, order number) is rejected, not passed on', () => {
    const withEmail = { ...row, stops: [{ ...row.stops[0], email: 'x@example.test' }] };
    const withNumber = { ...row, stops: [{ ...row.stops[0], order_number: 'A248' }] };
    expect(deliveryListRow.safeParse(withEmail).success).toBe(false);
    expect(deliveryListRow.safeParse(withNumber).success).toBe(false);
  });

  it('maps to the API shape', () => {
    const list = toDeliveryList(deliveryListRow.parse(row));
    expect(list.pendingCount).toBe(2);
    expect(list.stops[0]).toEqual({ name: 'Dana', phone: '+972501234567', address: 'Herzl 1', city: 'Ramat Gan', timeWindow: '10:00-12:00', notes: 'Floor 2' });
  });

  it('agent view (SEC-004): counts per city only, no name, phone, address or notes', () => {
    const agent = redactDeliveryListForAgent(toDeliveryList(deliveryListRow.parse(row)));
    expect(agent).toEqual({ day: '2027-03-04', stopCount: 3, pendingCount: 2, stopsPerCity: { 'Ramat Gan': 2, Haifa: 1 } });
    expect(JSON.stringify(agent)).not.toMatch(/Dana|\+972|Herzl|Floor/);
  });
});
