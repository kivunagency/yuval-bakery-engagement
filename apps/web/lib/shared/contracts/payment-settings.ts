import { z } from 'zod';
import { safePaymentLink, type PaymentMethod } from '@/lib/shared/payment/links';

// Payment links editor (settings-payment, SEC-009). A link is accepted only if
// safePaymentLink() would show it on the order page (https, allowlisted host,
// no user or port); it is stored in the form new URL() writes. The DB function
// fn_admin_set_payment_links checks the same allowlist again and requires a
// TOTP step from the last 5 minutes. Empty or null unsets a link.

export const PAYMENT_LINK_MAX = 500;
export const STEP_UP_MAX_AGE_SECONDS = 300;

const link = (method: PaymentMethod) =>
  z.union([z.null(), z.string()]).transform((v, ctx) => {
    if (v === null || v.trim() === '') return null;
    const safe = v.trim().length <= PAYMENT_LINK_MAX ? safePaymentLink(method, v.trim()) : null;
    if (!safe || safe.length > PAYMENT_LINK_MAX || /\s/.test(safe)) {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
    return safe;
  });

/** PUT /api/admin/settings/payment-links body: at least one link, and a fresh 6-digit TOTP code. */
export const paymentLinksUpdate = z
  .object({
    bit: link('bit').optional(),
    paybox: link('paybox').optional(),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict()
  .refine((p) => p.bit !== undefined || p.paybox !== undefined, 'empty_update');
export type PaymentLinksUpdate = z.infer<typeof paymentLinksUpdate>;

/** The fields of an update that failed validation. */
export function invalidPaymentFields(raw: unknown): string[] {
  const r = paymentLinksUpdate.safeParse(raw);
  if (r.success) return [];
  return [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
}

export const paymentLinkState = z.object({
  /** What is stored (may be a value the order page refuses, then shownToCustomers is false). */
  value: z.string().nullable(),
  shownToCustomers: z.boolean(),
  updatedAt: z.string().nullable(),
});
export const paymentLinkSettings = z.object({ bit: paymentLinkState, paybox: paymentLinkState });
export type PaymentLinkSettings = z.infer<typeof paymentLinkSettings>;

export const PAYMENT_SETTINGS_API_ERRORS = ['unauthorized', 'forbidden_origin', 'invalid_input', 'invalid_code', 'rate_limited', 'step_up_required', 'server_error'] as const;
export const paymentSettingsApiError = z.object({ error: z.enum(PAYMENT_SETTINGS_API_ERRORS), fields: z.array(z.string()).optional() });
export type PaymentSettingsApiErrorBody = z.infer<typeof paymentSettingsApiError>;

export const paymentLinksUpdateResponse = paymentLinkSettings.extend({ changed: z.array(z.enum(['bit', 'paybox'])) });
export type PaymentLinksUpdateResponse = z.infer<typeof paymentLinksUpdateResponse>;
