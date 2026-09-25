import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FULFILLMENT_TYPES, ORDER_SOURCES, ORDER_STATUSES, type OrderStatus } from '@/lib/shared/types';
import { addDays } from '@/lib/shared/time/jerusalem';
import type { AdminOrderView, AdminOrdersView } from '@/lib/shared/contracts/admin-orders';

// Reads behind the admin orders screen (client-009). `client` is always
// createUserClient(): RLS lets an aal2 admin read orders, order_items,
// customers, capacity_day_ledger and app_settings; nothing here writes.
// The screen arrives with this data (server-rendered); only actions fetch.

/** How many orders one status view shows (newest first for the terminal states). */
export const ORDER_LIST_LIMIT = 100;
/** An expired order is flagged as "maybe paid late" for this long after it expired (blindspot-005). */
export const RECENT_EXPIRY_HOURS = 48;
/** The holds indicator looks this many days ahead (the days customers can actually book); a day filter shows that day only. */
export const HOLDS_HORIZON_DAYS = 60;
/** Unpaid share of a day from which the holds indicator is shown as high (threat-model.md 3.1 item 5). */
export const HOLDS_ALERT_PCT = 50;

const orderRow = z.object({
  id: z.string(),
  order_number: z.string(),
  status: z.enum(ORDER_STATUSES),
  order_source: z.enum(ORDER_SOURCES),
  customer_id: z.string().nullable(),
  guest_name: z.string().nullable(),
  guest_phone: z.string().nullable(),
  guest_email: z.string().nullable(),
  fulfillment_type: z.enum(FULFILLMENT_TYPES),
  delivery_date: z.string(),
  delivery_time_window: z.string().nullable(),
  delivery_city: z.string().nullable(),
  total_displayed: z.coerce.number(),
  confirmation_delivered_at: z.string().nullable(),
  payment_pending_expires_at: z.string().nullable(),
  expired_at: z.string().nullable(),
  pii_purged_at: z.string().nullable(),
});
const ORDER_COLUMNS = orderRow.keyof().options.join(', ');

const itemRow = z.object({ order_id: z.string(), product_name_snapshot: z.string(), quantity: z.number().int() });
const customerRow = z.object({ id: z.string(), name: z.string().nullable(), phone: z.string().nullable(), email: z.string().nullable() });
const holdRow = z.object({
  day: z.string(),
  oven_minutes_total: z.number().int(),
  oven_minutes_unpaid_reserved: z.number().int(),
  work_minutes_total: z.number().int(),
  work_minutes_unpaid_reserved: z.number().int(),
});

const ORDER_BY: Record<OrderStatus, { column: string; ascending: boolean }> = {
  payment_pending: { column: 'delivery_date', ascending: true },
  paid: { column: 'delivery_date', ascending: true },
  fulfilled: { column: 'fulfilled_at', ascending: false },
  expired: { column: 'expired_at', ascending: false },
  cancelled: { column: 'cancelled_at', ascending: false },
};

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part * 100) / total) : 0;
}

/** `day`: only orders for that delivery day (list and counts); the holds and the recent-expiry banner stay global. */
export async function loadAdminOrders(
  client: SupabaseClient,
  { status, day, today, now }: { status: OrderStatus; day: string | null; today: string; now: Date },
): Promise<AdminOrdersView> {
  const order = ORDER_BY[status];
  const recentSince = new Date(now.getTime() - RECENT_EXPIRY_HOURS * 3600 * 1000).toISOString();
  const count = (s: OrderStatus) => {
    const q = client.from('orders').select('id', { count: 'exact', head: true }).eq('status', s);
    return day ? q.eq('delivery_date', day) : q;
  };
  const listQuery = client.from('orders').select(ORDER_COLUMNS).eq('status', status);

  const [list, recent, holds, pending, cap, ...counts] = await Promise.all([
    (day ? listQuery.eq('delivery_date', day) : listQuery).order(order.column, { ascending: order.ascending }).order('created_at').limit(ORDER_LIST_LIMIT),
    client.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'expired').gte('expired_at', recentSince).gte('delivery_date', today),
    client
      .from('capacity_day_ledger')
      .select('day, oven_minutes_total, oven_minutes_unpaid_reserved, work_minutes_total, work_minutes_unpaid_reserved')
      .gte('day', day ?? today)
      .lte('day', day ?? addDays(today, HOLDS_HORIZON_DAYS))
      .or('oven_minutes_unpaid_reserved.gt.0,work_minutes_unpaid_reserved.gt.0')
      .order('day'),
    client.from('orders').select('delivery_date').eq('status', 'payment_pending').gte('delivery_date', today),
    client.from('app_settings').select('value').eq('key', 'unpaid_holds_capacity_pct').maybeSingle(),
    ...ORDER_STATUSES.map(count),
  ]);
  for (const r of [list, recent, holds, pending, cap, ...counts]) if (r.error) throw new Error('admin_orders_read_failed');

  const rows = z.array(orderRow).parse(list.data);
  const ids = rows.map((r) => r.id);
  const customerIds = [...new Set(rows.flatMap((r) => (r.customer_id ? [r.customer_id] : [])))];
  const [items, customers] = await Promise.all([
    ids.length ? client.from('order_items').select('order_id, product_name_snapshot, quantity').in('order_id', ids).order('created_at') : { data: [], error: null },
    customerIds.length ? client.from('customers').select('id, name, phone, email').in('id', customerIds) : { data: [], error: null },
  ]);
  if (items.error || customers.error) throw new Error('admin_orders_read_failed');

  const itemsByOrder = new Map<string, { name: string; quantity: number }[]>();
  for (const i of z.array(itemRow).parse(items.data)) {
    itemsByOrder.set(i.order_id, [...(itemsByOrder.get(i.order_id) ?? []), { name: i.product_name_snapshot, quantity: i.quantity }]);
  }
  const customerById = new Map(z.array(customerRow).parse(customers.data).map((c) => [c.id, c]));

  const orders: AdminOrderView[] = rows.map((r) => {
    const customer = r.customer_id ? customerById.get(r.customer_id) : undefined;
    const hasEmail = !!r.guest_email || !!customer?.email;
    return {
      id: r.id,
      orderNumber: r.order_number,
      status: r.status,
      source: r.order_source,
      name: r.guest_name ?? customer?.name ?? null,
      phone: r.guest_phone ?? customer?.phone ?? null,
      fulfillment: r.fulfillment_type,
      deliveryDate: r.delivery_date,
      timeWindow: r.delivery_time_window,
      city: r.delivery_city,
      total: r.total_displayed,
      items: itemsByOrder.get(r.id) ?? [],
      confirmationMissing: !hasEmail && !r.confirmation_delivered_at,
      expiresAt: r.payment_pending_expires_at,
      expiredAt: r.expired_at,
      piiPurged: !!r.pii_purged_at,
    };
  });

  const unpaidOrdersByDay = new Map<string, number>();
  for (const p of z.array(z.object({ delivery_date: z.string() })).parse(pending.data)) {
    unpaidOrdersByDay.set(p.delivery_date, (unpaidOrdersByDay.get(p.delivery_date) ?? 0) + 1);
  }
  const unpaidDays = z
    .array(holdRow)
    .parse(holds.data)
    .map((h) => ({
      day: h.day,
      unpaidPct: Math.max(pct(h.oven_minutes_unpaid_reserved, h.oven_minutes_total), pct(h.work_minutes_unpaid_reserved, h.work_minutes_total)),
      unpaidOrders: unpaidOrdersByDay.get(h.day) ?? 0,
    }));

  const capValue = cap.data ? Number(cap.data.value) : NaN;
  return {
    status,
    day,
    orders,
    counts: Object.fromEntries(ORDER_STATUSES.map((s, i) => [s, counts[i]?.count ?? 0])) as Record<OrderStatus, number>,
    recentlyExpired: recent.count ?? 0,
    unpaidDays,
    unpaidCapPct: Number.isFinite(capValue) ? capValue : null,
  };
}
