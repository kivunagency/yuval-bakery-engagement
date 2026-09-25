import 'server-only';
import { dispatch } from '@/lib/server/notification/dispatch';
import type { ConfirmationPdf, NotificationReport } from '@/lib/server/notification/types';

// Notification context (job-002, domain-map section 3). One function per
// domain event. This is the STABLE interface other contexts call:
//
//   import { OrderCreated } from '@/lib/server/notification';
//   after(() => OrderCreated({ orderId }));          // checkout (api-003)
//   after(() => CustomCakeRequested({ requestId })); // custom-cake submit
//   after(() => CustomCakeApproved({ requestId }));  // after fn_approve_custom_cake_request
//   after(() => CustomCakeDeclined({ requestId }));  // after the decline function
//
// Contract:
// - Call it AFTER the DB transaction that created the order / request has
//   committed. Pass only the id: the content is read from the DB here, never
//   from the caller or the customer (SEC-015: no free text in outgoing mail).
// - It NEVER throws and never touches the order. A failed or refused
//   notification cannot fail or roll back the order. Every attempt and its
//   outcome is a row in `notification_attempts`.
// - Idempotent per (event, entity, channel, recipient): calling it twice
//   (a retry) does not send twice.
// - Use `after()` from 'next/server' so the response is not held up and the
//   work still finishes on serverless (a bare un-awaited promise may be cut).
//   Awaiting it directly is also fine; it resolves to a report, never rejects.

export type { NotificationReport, ChannelOutcome, ConfirmationPdf } from '@/lib/server/notification/types';

/** New standard order: push + email to the admin; confirmation email to the customer (needs the PDF, see ConfirmationPdf). */
export function OrderCreated(input: { orderId: string; confirmationPdf?: ConfirmationPdf }): Promise<NotificationReport> {
  return dispatch({ event: 'order_created', entityId: input.orderId, confirmationPdf: input.confirmationPdf });
}

/** New custom-cake request (pending_review): push + email to the admin. Nothing to the customer. */
export function CustomCakeRequested(input: { requestId: string }): Promise<NotificationReport> {
  return dispatch({ event: 'custom_cake_requested', entityId: input.requestId });
}

/** Custom cake approved (order now payment_pending): email to the customer, if they gave one. */
export function CustomCakeApproved(input: { requestId: string }): Promise<NotificationReport> {
  return dispatch({ event: 'custom_cake_approved', entityId: input.requestId });
}

/** Custom cake declined: email to the customer, if they gave one, with the admin's optional reason. */
export function CustomCakeDeclined(input: { requestId: string }): Promise<NotificationReport> {
  return dispatch({ event: 'custom_cake_declined', entityId: input.requestId });
}
