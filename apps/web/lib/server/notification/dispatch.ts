import 'server-only';
import type { ConfirmationPdf, NotificationEvent, NotificationReport } from '@/lib/server/notification/types';

export type DispatchInput = { event: NotificationEvent; entityId: string; confirmationPdf?: ConfirmationPdf };

// Interface-first commit: the implementation lands in the next commits of
// feature/job-002-notification-service. It already honours the contract:
// never throws, touches nothing.
export async function dispatch(input: DispatchInput): Promise<NotificationReport> {
  return { event: input.event, entityId: input.entityId, outcomes: [] };
}
