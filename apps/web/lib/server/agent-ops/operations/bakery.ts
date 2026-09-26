import 'server-only';
import { defineOperation } from './types';
import { ok, fail, type Failure } from '../result';
import { uuid, isoDate } from '@/lib/shared/contracts/primitives';
import { customCakeApprove } from '@/lib/shared/contracts/custom-cake';
import { dayCapacityPatch } from '@/lib/shared/contracts/capacity';
import { redactDeliveryListForAgent } from '@/lib/shared/contracts/delivery-list';
import { markOrderPaid } from '@/lib/server/ordering/admin-orders';
import { approveCustomCake, declineCustomCake } from '@/lib/server/custom-cake/admin';
import { generateDeliveryList } from '@/lib/server/delivery/delivery-list';
import { updateDayCapacity } from '@/lib/server/capacity/admin-capacity';

/**
 * The five business operations ADR-001 ("Rule 27: operations registry: GO")
 * names, and nothing else. Each one calls the SAME handler the admin UI route
 * calls, with ctx.client (the delegating admin's own aal2 JWT), so the DB
 * checks aal2, decides capacity (fn_reserve_capacity / fn_release_order_capacity
 * only) and writes its own audit row exactly as for a click in the UI. No
 * handler here reads or decides a status, a price or "is there room".
 *
 * What goes back to the agent is smaller than what the UI gets (SECURITY.md D,
 * threat-model 3.7): no customer name, phone, address or notes, no capability
 * link (SEC-003), no WhatsApp link (it carries the phone).
 */

/** The admin handlers' `{ error: 'snake_case' }` as a registry failure. */
function fromHandler(status: number, error: string, details?: Record<string, unknown>): Failure {
  const code = error.toUpperCase();
  if (status === 401) return fail('UNAUTHORIZED', 'The delegating admin session is no longer at aal2. Mint a new agent token.');
  if (status === 404) return fail('NOT_FOUND', 'Not found.');
  return fail(code, `Refused: ${error}.`, details);
}

export const markOrderPaidOp = defineOperation({
  name: 'markOrderPaid',
  title: 'Mark order paid',
  description:
    'Record that the customer paid an order (payment_pending -> paid); the reserved oven and work minutes stay reserved. ' +
    'Needs the order id (uuid). Only after the money is confirmed in the bank or payment app: this is financial. ' +
    'Returns the order number and its new status. INVALID_TRANSITION when the order is not waiting for payment (already paid, expired, cancelled). Needs confirmation.',
  permission: 'write',
  roles: ['operator'],
  requiresConfirmation: true,
  module: 'orders',
  inputSchema: { orderId: uuid.describe('Order id (uuid), not the 6-character order number.') },
  async handler({ orderId }, ctx) {
    const r = await markOrderPaid(ctx.client, orderId);
    if (!r.ok) return fromHandler(r.status, r.body.error, r.body.status ? { status: r.body.status } : undefined);
    return ok({ orderNumber: r.value.orderNumber, status: r.value.status });
  },
});

export const approveCustomCakeRequestOp = defineOperation({
  name: 'approveCustomCakeRequest',
  title: 'Approve custom cake request',
  description:
    'Approve a pending custom-cake request at a price and a cost in oven and work minutes. In one DB transaction this creates the order ' +
    '(payment_pending) and reserves the minutes on the requested day; if the day no longer has room nothing is written (CAPACITY_CHANGED). ' +
    'Returns the order number, total and payment deadline. The customer is not contacted by this call. Needs confirmation.',
  permission: 'write',
  roles: ['operator'],
  requiresConfirmation: true,
  module: 'custom_cakes',
  inputSchema: {
    requestId: uuid.describe('Custom-cake request id (uuid).'),
    price: customCakeApprove.shape.price.describe('Price in shekels, more than 0, at most 2 decimals.'),
    ovenMinutes: customCakeApprove.shape.ovenMinutes.describe('Oven minutes the cake takes, 0..1440.'),
    workMinutes: customCakeApprove.shape.workMinutes.describe('Work minutes the cake takes, 0..1440.'),
  },
  async handler({ requestId, ...input }, ctx) {
    const r = await approveCustomCake(ctx.client, requestId, input);
    if (!r.ok) return fromHandler(r.status, r.error, r.check ? { capacityCheck: r.check } : undefined);
    return ok({ orderNumber: r.value.orderNumber, total: r.value.total, paymentPendingExpiresAt: r.value.paymentPendingExpiresAt });
  },
});

export const declineCustomCakeRequestOp = defineOperation({
  name: 'declineCustomCakeRequest',
  title: 'Decline custom cake request',
  description:
    'Decline a pending custom-cake request. Nothing is reserved, so nothing is released. No reason text can be given here: a reason reaches the ' +
    'customer and only Yuval writes it, in the admin screen (threat-model 3.5). NOT_PENDING when it was already approved or declined. Needs confirmation.',
  permission: 'write',
  roles: ['operator'],
  requiresConfirmation: true,
  module: 'custom_cakes',
  inputSchema: { requestId: uuid.describe('Custom-cake request id (uuid).') },
  async handler({ requestId }, ctx) {
    const r = await declineCustomCake(ctx.client, requestId, '');
    if (!r.ok) return fromHandler(r.status, r.error);
    return ok({ declined: true });
  },
});

export const generateDeliveryListOp = defineOperation({
  name: 'generateDeliveryList',
  title: 'Delivery list summary',
  description:
    'How many paid deliveries a day has, per city, and how many delivery orders still wait for payment. ' +
    'Counts only: an agent never gets names, phones, addresses or notes (the full list is for the admin screen). ' +
    'Each call is recorded in the audit log as a list generation.',
  permission: 'read',
  roles: ['verifier'],
  module: 'delivery',
  inputSchema: { date: isoDate.describe('Delivery day, YYYY-MM-DD.') },
  async handler({ date }, ctx) {
    const r = await generateDeliveryList(ctx.client, { date });
    if (!r.ok) return fromHandler(r.status, r.body.error);
    return ok(redactDeliveryListForAgent(r.value));
  },
});

export const updateDayCapacityOp = defineOperation({
  name: 'updateDayCapacity',
  title: 'Update day capacity',
  description:
    "Set one day's total oven minutes and work minutes and whether it is a blackout day (no orders). " +
    'Refused with BELOW_RESERVED (and the reserved minutes) when a total is below what orders already hold; nothing is released by this call. ' +
    'Returns the day as the DB now has it. Needs confirmation.',
  permission: 'write',
  roles: ['operator'],
  requiresConfirmation: true,
  module: 'capacity',
  inputSchema: {
    date: isoDate.describe('Day, YYYY-MM-DD.'),
    ovenMinutesTotal: dayCapacityPatch.shape.ovenMinutesTotal.describe('Total oven minutes, 0..1440.'),
    workMinutesTotal: dayCapacityPatch.shape.workMinutesTotal.describe('Total work minutes, 0..1440.'),
    isBlackout: dayCapacityPatch.shape.isBlackout.describe('true: no orders that day.'),
  },
  async handler({ date, ...patch }, ctx) {
    const r = await updateDayCapacity(ctx.client, date, patch);
    if (!r.ok) return fromHandler(r.status, r.body.error, r.body.reserved ? { reserved: r.body.reserved } : undefined);
    return ok(r.value);
  },
});

export const BAKERY_OPERATIONS = [markOrderPaidOp, approveCustomCakeRequestOp, declineCustomCakeRequestOp, generateDeliveryListOp, updateDayCapacityOp];
