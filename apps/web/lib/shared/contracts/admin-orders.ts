import { z } from 'zod';
import { isoDate, uuid } from '@/lib/shared/contracts/primitives';
import { ORDER_STATUSES, type FulfillmentType, type OrderSource, type OrderStatus } from '@/lib/shared/types';

// Admin order actions (api-004) and the orders screen (client-009).
// POST /api/admin/orders/[id]/mark-paid | cancel | mark-fulfilled, and
// POST /api/admin/orders/release-unpaid. Whether a transition is allowed is
// decided by the DB functions (fn_mark_order_paid, fn_cancel_order,
// fn_mark_order_fulfilled, fn_admin_release_unpaid_for_day), never here.

export const ADMIN_ORDER_ACTIONS = ['mark-paid', 'cancel', 'mark-fulfilled'] as const;
export type AdminOrderAction = (typeof ADMIN_ORDER_ACTIONS)[number];

export const orderIdParam = uuid;

/** The action routes take no input besides the id: an empty JSON object, or no body. Unknown keys are rejected. */
export const orderActionBody = z.object({}).strict();

export const adminOrderActionResult = z.object({
  id: uuid,
  orderNumber: z.string(),
  status: z.enum(ORDER_STATUSES),
});
export type AdminOrderActionResult = z.infer<typeof adminOrderActionResult>;

/** POST /api/admin/orders/release-unpaid body. */
export const releaseUnpaidBody = z.object({ day: isoDate }).strict();
export type ReleaseUnpaidBody = z.infer<typeof releaseUnpaidBody>;

/** fn_admin_release_unpaid_for_day's JSON, as the DB returns it. */
export const releaseUnpaidRow = z.object({
  day: isoDate,
  released: z.number().int().min(0),
  order_numbers: z.array(z.string()),
});

export const releaseUnpaidResult = z.object({
  day: isoDate,
  released: z.number().int().min(0),
  orderNumbers: z.array(z.string()),
});
export type ReleaseUnpaidResult = z.infer<typeof releaseUnpaidResult>;

/**
 * Error body. `status` (the order's current status) is set for
 * invalid_transition, so the screen can say what happened in between.
 * confirmation_required: US-0c, the DB refused `fulfilled` because a guest
 * with no email has not been sent the written confirmation yet.
 */
export const ADMIN_ORDERS_API_ERRORS = [
  'unauthorized',
  'forbidden_origin',
  'invalid_input',
  'not_found',
  'invalid_transition',
  'confirmation_required',
  'server_error',
] as const;
export type AdminOrdersApiError = (typeof ADMIN_ORDERS_API_ERRORS)[number];
export const adminOrdersApiError = z.object({
  error: z.enum(ADMIN_ORDERS_API_ERRORS),
  status: z.enum(ORDER_STATUSES).optional(),
});
export type AdminOrdersApiErrorBody = z.infer<typeof adminOrdersApiError>;

/** Status filter of the orders screen (?status=). Anything else: waiting for payment. */
export const orderListFilter = z.enum(ORDER_STATUSES).catch('payment_pending');
/** Optional delivery-day filter (?day=YYYY-MM-DD); anything else: all days. */
export const orderListDay = isoDate.nullable().catch(null);

// ---- orders screen view (client-009), built server-side by loadAdminOrders ----

export type AdminOrderView = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: OrderSource;
  name: string | null;
  /** As stored (E.164). Displayed LTR-isolated; the wa.me link is built from it on the server. */
  phone: string | null;
  fulfillment: FulfillmentType;
  deliveryDate: string;
  timeWindow: string | null;
  city: string | null;
  total: number;
  items: { name: string; quantity: number }[];
  /** US-0c: no email on the order or the customer, and the confirmation not delivered yet. Only meaningful for `paid`. */
  confirmationMissing: boolean;
  expiresAt: string | null;
  expiredAt: string | null;
  piiPurged: boolean;
};

export type UnpaidDay = {
  day: string;
  /** The larger of the two resources: unpaid minutes / day total, whole percent. */
  unpaidPct: number;
  unpaidOrders: number;
};

export type AdminOrdersView = {
  status: OrderStatus;
  day: string | null;
  orders: AdminOrderView[];
  counts: Record<OrderStatus, number>;
  /** Expired within RECENT_EXPIRY_HOURS for a day that has not passed: may have been paid late. */
  recentlyExpired: number;
  unpaidDays: UnpaidDay[];
  unpaidCapPct: number | null;
};
