import 'server-only';
import { z } from 'zod';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { safePaymentLink } from '@/lib/shared/payment/links';

// Yuval's Bit and PayBox links (SEC-009), through the one whitelisting DB
// function. A value that is unset or fails the host allowlist comes back as
// null, and the order page shows a visible placeholder instead of a button.
const row = z.object({ bit: z.string().nullable(), paybox: z.string().nullable() });

export type PaymentLinks = { bit: string | null; paybox: string | null };

export async function getPaymentLinks(): Promise<PaymentLinks> {
  try {
    const r = await callRpc(serviceClient(), 'fn_payment_link_settings', {}, row);
    return { bit: safePaymentLink('bit', r.bit), paybox: safePaymentLink('paybox', r.paybox) };
  } catch (err) {
    console.error('fn_payment_link_settings failed', err instanceof Error ? err.message : 'unknown');
    return { bit: null, paybox: null };
  }
}
