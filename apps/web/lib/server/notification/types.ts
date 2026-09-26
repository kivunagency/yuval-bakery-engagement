// Types of the Notification context. No I/O here.

export const NOTIFICATION_EVENTS = [
  'order_created',
  'custom_cake_requested',
  'custom_cake_approved',
  'custom_cake_declined',
  'email_quota_alert',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type Channel = 'email' | 'push';
export type Audience = 'admin' | 'customer';

/** Mirrors notification_attempts.status. */
export type AttemptStatus = 'sent' | 'failed' | 'refused' | 'skipped' | 'duplicate';

/** One line of a report: what happened on one channel for one recipient. Never carries PII. */
export type ChannelOutcome = {
  channel: Channel;
  audience: Audience;
  status: AttemptStatus;
  /** Why it was not sent (refusal/skip/failure code), or null when sent. */
  reason: string | null;
};

export type NotificationReport = {
  event: NotificationEvent;
  entityId: string;
  outcomes: ChannelOutcome[];
};

/**
 * The order-confirmation PDF (US-0c, lib/server/confirmation). Without it the
 * customer's confirmation email is recorded as `skipped`
 * (`confirmation_pdf_pending`) and not sent: that email exists to deliver the
 * s.14C written confirmation, which is the PDF. `url` is its 24-month link,
 * shown in the email. Recording the delivery on the order
 * (`fn_record_order_confirmation_delivered`, channel email) is done by the
 * caller, lib/server/confirmation/on-order-created.ts, once the email was sent.
 */
export type ConfirmationPdf = { filename: string; content: Uint8Array; url?: string };
