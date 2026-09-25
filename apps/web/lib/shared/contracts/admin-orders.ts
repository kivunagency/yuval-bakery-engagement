import { z } from 'zod';
import { uuid } from '@/lib/shared/contracts/primitives';
import { ORDER_STATUSES } from '@/lib/shared/types';

// Admin order actions (api-004).
// POST /api/admin/orders/[id]/mark-paid | cancel | mark-fulfilled. Whether a
// transition is allowed is decided by the DB functions (fn_mark_order_paid,
// fn_cancel_order, fn_mark_order_fulfilled), never here.

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
