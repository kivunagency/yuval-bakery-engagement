import { z } from 'zod';
import { ilMobilePhone, isoDate, optionalEmail, personName } from '@/lib/shared/contracts/primitives';
import { MAX_LINE_QUANTITY } from '@/lib/shared/cart';
import { FULFILLMENT_TYPES, ORDER_STATUSES } from '@/lib/shared/types';

// Checkout and order contracts (api-003, client-003, client-004).
// The client sends WHAT it wants (product ids, quantities, day, slot, city,
// contact details), never an amount: price, delivery fee and capacity are
// decided by the DB (SEC-008, fn_create_standard_order).

export const MAX_ORDER_LINES = 30;

const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/);

// ---- POST /api/orders ----
export const createOrderRequest = z
  .object({
    items: z
      .array(z.object({ productId: z.guid(), quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }).strict())
      .min(1)
      .max(MAX_ORDER_LINES)
      .refine((items) => new Set(items.map((i) => i.productId.toLowerCase())).size === items.length, 'duplicate_product'),
    day: isoDate,
    slotId: z.guid(),
    fulfillment: z.enum(FULFILLMENT_TYPES),
    city: z.string().trim().max(80).optional(),
    address: z.string().trim().max(200).optional(),
    name: personName.max(60),
    phone: ilMobilePhone,
    email: optionalEmail.optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.fulfillment === 'delivery') {
      if (!v.city) ctx.addIssue({ code: 'custom', path: ['city'], message: 'required' });
      if (!v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'required' });
    }
  });
export type CreateOrderRequest = z.infer<typeof createOrderRequest>;

/** 201 body: the capability token for /order/<token> (SEC-003). Nothing else. */
export const createOrderResponse = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });
export type CreateOrderResponse = z.infer<typeof createOrderResponse>;

/**
 * What went wrong, as the screen needs it. `pickAnotherDay` = capacity (or the
 * day) is gone: the customer goes back to the day picker. Never retried
 * silently by the client.
 */
export const CHECKOUT_ERRORS = [
  'invalid_input',
  'forbidden_origin',
  'day_full',
  'day_almost_full',
  'order_too_big',
  'too_soon',
  'slot_unavailable',
  'city_not_served',
  'product_unavailable',
  'too_many_attempts',
  'too_many_open_orders',
  'server_error',
] as const;
export type CheckoutError = (typeof CHECKOUT_ERRORS)[number];

export const checkoutErrorBody = z.object({
  error: z.enum(CHECKOUT_ERRORS),
  pickAnotherDay: z.boolean().optional(),
  fields: z.array(z.string()).optional(),
});
export type CheckoutErrorBody = z.infer<typeof checkoutErrorBody>;

// ---- GET /api/delivery-zones ----
export const publicZone = z.object({
  id: z.guid(),
  name: z.string().max(200),
  fee: z.number().nonnegative(),
  cities: z.array(z.string().max(80)),
});
export type PublicZone = z.infer<typeof publicZone>;
export const deliveryZonesResponse = z.object({ zones: z.array(publicZone) });
export type DeliveryZonesResponse = z.infer<typeof deliveryZonesResponse>;

// ---- time slots (server-rendered into the checkout page) ----
export const timeSlot = z.object({ id: z.guid(), start: hhmm, end: hhmm });
export type TimeSlot = z.infer<typeof timeSlot>;

// ---- the order page (client-004), from fn_order_for_lookup_token ----
export const lookupToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const orderView = z.object({
  orderNumber: z.string().max(20),
  status: z.enum(ORDER_STATUSES),
  fulfillment: z.enum(FULFILLMENT_TYPES),
  day: isoDate,
  slotStart: hhmm.nullable(),
  slotEnd: hhmm.nullable(),
  city: z.string().max(80).nullable(),
  subtotal: z.number().nonnegative(),
  deliveryFee: z.number().nonnegative(),
  total: z.number().nonnegative(),
  /** ISO instant; null only for orders that never held a payment window. */
  paymentPendingExpiresAt: z.string().nullable(),
  items: z.array(z.object({ name: z.string().max(200), quantity: z.number().int(), unitPrice: z.number(), lineTotal: z.number() })),
});
export type OrderView = z.infer<typeof orderView>;
