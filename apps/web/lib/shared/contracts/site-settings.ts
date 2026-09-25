import { z } from 'zod';

// Result of the DB function fn_public_site_settings() (migration
// 20260926030000). Every business field is null until Yuval sets it; the UI
// renders a visible placeholder for null (never an invented value).
const maybeText = z.string().max(500).nullable();
const maybeInt = z.number().int().nonnegative().nullable();

export const publicSiteSettings = z.object({
  business_name: maybeText,
  business_owner_name: maybeText,
  business_registration_number: maybeText,
  business_address: maybeText,
  business_phone: maybeText,
  business_whatsapp: maybeText,
  business_email: maybeText,
  vat_status: maybeText,
  active_privacy_notice_version: maybeText,
  active_terms_version: maybeText,
  active_cancellation_notice_version: maybeText,
  guest_pii_months: maybeInt,
  photo_retention_days: maybeInt,
  inactive_profile_months: maybeInt,
});
export type PublicSiteSettings = z.infer<typeof publicSiteSettings>;

/** What the UI renders when the settings could not be read: every value unset. */
export const EMPTY_SITE_SETTINGS: PublicSiteSettings = {
  business_name: null,
  business_owner_name: null,
  business_registration_number: null,
  business_address: null,
  business_phone: null,
  business_whatsapp: null,
  business_email: null,
  vat_status: null,
  active_privacy_notice_version: null,
  active_terms_version: null,
  active_cancellation_notice_version: null,
  guest_pii_months: null,
  photo_retention_days: null,
  inactive_profile_months: null,
};
