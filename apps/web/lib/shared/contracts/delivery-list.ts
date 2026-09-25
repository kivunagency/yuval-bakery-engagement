import { z } from 'zod';
import { isoDate } from '@/lib/shared/contracts/primitives';

// Delivery list for one day (api-008, US-7). The fields are the courier's
// minimum (threat-model.md 3.6, compliance-spec.md section 7): no email,
// items, prices, inscription or order number. Built by fn_admin_delivery_list.

/** GET /api/admin/delivery-list?date=YYYY-MM-DD */
export const deliveryListQuery = z.object({ date: isoDate }).strict();
export type DeliveryListQuery = z.infer<typeof deliveryListQuery>;

/** One stop as the DB function returns it. */
export const deliveryStopRow = z
  .object({
    name: z.string().nullable(),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    time_window: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict();

export const deliveryListRow = z
  .object({
    day: z.string(),
    stops: z.array(deliveryStopRow),
    pending_count: z.number().int().nonnegative(),
  })
  .strict();
export type DeliveryListRow = z.infer<typeof deliveryListRow>;

export const deliveryStop = z
  .object({
    name: z.string(),
    phone: z.string(),
    address: z.string(),
    city: z.string(),
    timeWindow: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .strict();
export type DeliveryStop = z.infer<typeof deliveryStop>;

/** API response. `pendingCount`: delivery orders that day still waiting for payment, not on the list. */
export const deliveryList = z
  .object({
    day: isoDate,
    stops: z.array(deliveryStop),
    pendingCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeliveryList = z.infer<typeof deliveryList>;

export function toDeliveryList(row: DeliveryListRow): DeliveryList {
  return deliveryList.parse({
    day: row.day,
    stops: row.stops.map((s) => ({
      name: s.name ?? '',
      phone: s.phone ?? '',
      address: s.address ?? '',
      city: s.city ?? '',
      timeWindow: s.time_window,
      notes: s.notes,
    })),
    pendingCount: row.pending_count,
  });
}

/**
 * The only view of a delivery list an agent may get (SEC-004, threat-model 3.7):
 * counts per city, no name, phone, address or notes. For ops-registry-001.
 */
export function redactDeliveryListForAgent(list: DeliveryList): { day: string; stopCount: number; pendingCount: number; stopsPerCity: Record<string, number> } {
  const stopsPerCity: Record<string, number> = {};
  for (const s of list.stops) stopsPerCity[s.city] = (stopsPerCity[s.city] ?? 0) + 1;
  return { day: list.day, stopCount: list.stops.length, pendingCount: list.pendingCount, stopsPerCity };
}

export const DELIVERY_LIST_API_ERRORS = ['unauthorized', 'invalid_input', 'server_error'] as const;
export const deliveryListApiError = z.object({ error: z.enum(DELIVERY_LIST_API_ERRORS) });
export type DeliveryListApiErrorBody = z.infer<typeof deliveryListApiError>;
