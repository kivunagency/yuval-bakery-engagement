import 'server-only';
import { z } from 'zod';
import { OrderCreated, type NotificationReport } from '@/lib/server/notification';
import { callRpc } from '@/lib/server/supabase/rpc';
import { serviceClient } from '@/lib/server/supabase/service';
import { serverEnv } from '@/lib/server/env';
import { CONFIRMATION_BUCKET, ensureConfirmation } from '@/lib/server/confirmation/issue';

// Runs after a checkout order has committed (POST /api/orders, inside after()):
//   1. issue the confirmation PDF now, so the document records the order as
//      it was placed (US-0c);
//   2. OrderCreated: the admin's push and email, and the customer's email
//      with the PDF attached and its 24-month link (job-002's seam);
//   3. when that customer email was actually sent, record the delivery
//      (channel email) with the service role.
// Never throws: the order already exists and the customer already has their
// page. A failed step is logged by code only (SEC-026); the order page and
// the admin card still offer the PDF, which is issued on first use.
export async function onOrderCreated(orderId: string): Promise<NotificationReport | null> {
  try {
    const siteUrl = serverEnv().SITE_URL.replace(/\/+$/, '');
    let confirmation: Awaited<ReturnType<typeof ensureConfirmation>> = null;
    try {
      confirmation = await ensureConfirmation(orderId, siteUrl);
    } catch (e) {
      console.error('confirmation issue failed', orderId, e instanceof Error ? e.message : 'unknown');
    }
    let content: Uint8Array | undefined = confirmation?.pdf;
    if (confirmation && !content) {
      const { data } = await serviceClient().storage.from(CONFIRMATION_BUCKET).download(confirmation.storagePath);
      if (data) content = new Uint8Array(await data.arrayBuffer());
    }
    const report = await OrderCreated({
      orderId,
      confirmationPdf: confirmation && content ? { filename: confirmation.filename, content, url: `${siteUrl}${confirmation.path}` } : undefined,
    });
    const emailed = report.outcomes.some((o) => o.channel === 'email' && o.audience === 'customer' && o.status === 'sent');
    if (emailed && confirmation && !confirmation.deliveredAt) {
      await callRpc(serviceClient(), 'fn_record_order_confirmation_delivered', { p_order_id: orderId, p_channel: 'email' }, z.boolean());
    }
    return report;
  } catch (e) {
    console.error('order created follow-up failed', orderId, e instanceof Error ? e.message : 'unknown');
    return null;
  }
}
