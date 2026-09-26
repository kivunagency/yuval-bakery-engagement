import { z } from 'zod';
import { ilMobilePhone } from '@/lib/shared/contracts/primitives';
import { FULFILLMENT_TYPES, ORDER_STATUSES } from '@/lib/shared/types';

// Find my order (US-0d): POST /api/find-order. Phone AND order number
// together; the answer never says which of the two was wrong.

/** Upper case, spaces removed; "a2y7 ycp" -> "A2Y7YCP". The DB compares after the same step. */
export const orderNumberInput = z
  .string()
  .max(24)
  .transform((s) => s.replace(/\s/g, '').toUpperCase())
  .refine((s) => /^[A-Z0-9-]{3,16}$/.test(s), 'invalid_order_number');

export const findOrderRequest = z.object({ phone: ilMobilePhone, orderNumber: orderNumberInput }).strict();
export type FindOrderRequest = z.infer<typeof findOrderRequest>;

export const foundOrder = z.object({
  orderNumber: z.string(),
  status: z.enum(ORDER_STATUSES),
  day: z.string(),
  fulfillment: z.enum(FULFILLMENT_TYPES),
  /** City and the first character of the street, from the DB (never the full address). */
  maskedAddress: z.string().nullable(),
  /** "/confirmation/<token>": the confirmation PDF (US-0c), or null for an order that has none. */
  confirmationPath: z.string().nullable(),
});
export type FoundOrder = z.infer<typeof foundOrder>;

export const findOrderResponse = z.discriminatedUnion('result', [
  z.object({ result: z.literal('found'), order: foundOrder }),
  z.object({ result: z.literal('not_found') }),
]);
export type FindOrderResponse = z.infer<typeof findOrderResponse>;

export const FIND_ORDER_ERRORS = ['invalid_input', 'forbidden_origin', 'too_many_attempts', 'server_error'] as const;
export const findOrderErrorBody = z.object({ error: z.enum(FIND_ORDER_ERRORS), fields: z.array(z.string()).optional() });
export type FindOrderErrorBody = z.infer<typeof findOrderErrorBody>;
