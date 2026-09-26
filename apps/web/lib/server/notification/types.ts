// Types of the Notification context. No I/O here.

export const NOTIFICATION_EVENTS = [
  'order_created',
  'custom_cake_requested',
  'custom_cake_approved',
  'custom_cake_declined',
  'email_quota_alert',
  'payment_links_changed',
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
 * Seam for the order-confirmation PDF (wave 3, not built here). Until a caller
 * passes it, the customer's confirmation email is recorded as `skipped`
 * (`confirmation_pdf_pending`) and not sent: that email exists to deliver the
 * s.14C written confirmation, which is the PDF. Recording the delivery on the
 * order (`fn_record_order_confirmation_delivered`) belongs to the PDF task.
 */
export type ConfirmationPdf = { filename: string; content: Uint8Array };
