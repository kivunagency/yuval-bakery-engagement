import { z } from 'zod';
import { ilMobilePhone, personName } from '@/lib/shared/contracts/primitives';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';

// Optional customer registration (api-010, client-005, PRD US-4).
// Marketing consent is NOT part of the registration contract: it is its own
// act (s.30A), recorded by fn_set_marketing_consent through consentInput.

/** SEC-014: at least 12 characters. 72 is the bcrypt limit Supabase Auth hashes. */
export const customerPassword = z.string().min(12).max(72);

export const customerEmail = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** POST /api/customers */
export const registerInput = z.strictObject({
  name: personName,
  phone: ilMobilePhone,
  email: customerEmail,
  password: customerPassword,
  // compliance-spec section 5: a declaration, required to open an account.
  ageConfirmed: z.literal(true),
  // The privacy notice the form showed (s.11); must be the version this build renders.
  privacyNoticeVersion: z.literal(TEXT_VERSIONS.privacy),
});
export type RegisterInput = z.infer<typeof registerInput>;

/**
 * Same body for a new address, an address that already has an account, and
 * one waiting for confirmation (SEC-014: no account enumeration).
 */
export const registerAccepted = z.strictObject({ status: z.literal('check_email') });

export const registerErrorCode = z.enum(['invalid_input', 'weak_password', 'pwned_password', 'rate_limited', 'unavailable', 'forbidden_origin']);
export type RegisterErrorCode = z.infer<typeof registerErrorCode>;
export const registerError = z.strictObject({ error: registerErrorCode, fields: z.array(z.string()).optional() });

export const signInInput = z.strictObject({
  email: customerEmail,
  password: z.string().min(1).max(200),
});

/** A day of a month, no year (compliance-spec section 3). 29 Feb is allowed. */
export const dayMonth = z
  .strictObject({ day: z.number().int().min(1).max(31), month: z.number().int().min(1).max(12) })
  .refine(({ day, month }) => day <= new Date(Date.UTC(2000, month, 0)).getUTCDate(), 'invalid_day_of_month');
export type DayMonth = z.infer<typeof dayMonth>;

export const profileInput = z.strictObject({
  name: personName,
  phone: ilMobilePhone,
  birthday: dayMonth.nullable(),
  anniversary: dayMonth.nullable(),
});
export type ProfileInput = z.infer<typeof profileInput>;

/** The customer's own consent change, from the registration or profile screen. */
export const consentInput = z.strictObject({
  action: z.enum(['granted', 'withdrawn']),
  version: z.literal(TEXT_VERSIONS.marketing),
  source: z.enum(['registration', 'profile']),
});
export type ConsentInput = z.infer<typeof consentInput>;

/** What sign-up parks in Auth user_metadata until the email is confirmed. */
export const pendingRegistration = z.object({
  name: personName,
  phone: ilMobilePhone,
  privacy_notice_version: z.literal(TEXT_VERSIONS.privacy),
  age_confirmed: z.literal(true),
});
export const PENDING_REGISTRATION_KEY = 'yb_registration';

/** The account page's view of the signed-in customer (s.13: everything stored). */
export const customerProfile = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  phone: z.string(),
  email: z.string().nullable(),
  birthday_day: z.number().int().nullable(),
  birthday_month: z.number().int().nullable(),
  anniversary_day: z.number().int().nullable(),
  anniversary_month: z.number().int().nullable(),
  marketing_opt_in: z.boolean(),
  marketing_consent_version: z.string().nullable(),
  marketing_opt_in_at: z.string().nullable(),
  marketing_opt_out_at: z.string().nullable(),
  age_confirmed_18_at: z.string().nullable(),
  privacy_notice_version: z.string().nullable(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type CustomerProfile = z.infer<typeof customerProfile>;

export const consentEvent = z.object({
  action: z.enum(['granted', 'withdrawn']),
  consent_version: z.string(),
  source: z.string(),
  created_at: z.string(),
});
export type ConsentEvent = z.infer<typeof consentEvent>;

export const myOrder = z.object({
  order_number: z.string(),
  status: z.string(),
  fulfillment_type: z.string(),
  delivery_date: z.string(),
  total_displayed: z.union([z.number(), z.string()]).transform(Number),
  created_at: z.string(),
});
export type MyOrder = z.infer<typeof myOrder>;

/** One-click unsubscribe token: 32 hex chars (customers.unsubscribe_token). */
export const unsubscribeToken = z.string().regex(/^[0-9a-f]{32}$/);
