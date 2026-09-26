import { z } from 'zod';
import { toE164 } from '@/lib/shared/contact/links';

// Business details editor (settings-business): the s.14C business_* keys of
// compliance-002 and the osek status (vat_status). The DB function
// fn_admin_set_business_details (migration 20260926150000) repeats every rule
// below; this contract only lets the screen and the API answer in words
// before the DB is asked.
//
// Every business field is a string, or null to unset it: the site then shows
// its visible placeholder again (never an invented value).

export const BUSINESS_FIELDS = ['name', 'ownerName', 'registrationNumber', 'address', 'phone', 'whatsapp', 'email'] as const;
export type BusinessField = (typeof BUSINESS_FIELDS)[number];

/** API field -> app_settings key. */
export const BUSINESS_SETTING_KEYS = {
  name: 'business_name',
  ownerName: 'business_owner_name',
  registrationNumber: 'business_registration_number',
  address: 'business_address',
  phone: 'business_phone',
  whatsapp: 'business_whatsapp',
  email: 'business_email',
  vatStatus: 'vat_status',
} as const;

export const VAT_STATUSES = ['exempt', 'licensed'] as const;
export type VatStatus = (typeof VAT_STATUSES)[number];

export const BUSINESS_LIMITS = {
  name: { min: 2, max: 60 },
  ownerName: { min: 2, max: 60 },
  address: { min: 5, max: 150 },
  email: { max: 254 },
} as const;

/** Trim and collapse inner whitespace, as the DB expects it. */
export const normalizeText = (s: string) => s.trim().replace(/\s+/g, ' ');

const CONTROL = /[\u0000-\u001f\u007f]/;

/** 9 digits with a valid Israeli ID check digit (osek number = ID number). Mirror of fn_is_valid_israeli_id. */
export function isValidIsraeliId(s: string): boolean {
  if (!/^\d{9}$/.test(s) || s === '000000000') return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = Number(s[i]) * (i % 2 === 0 ? 1 : 2);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

const text = (min: number, max: number) =>
  z
    .string()
    .refine((s) => !CONTROL.test(s))
    .transform(normalizeText)
    .pipe(z.string().min(min).max(max));

/** Empty after trimming = unset (null). */
const optional = <T extends z.ZodType<string | null>>(schema: T) =>
  z.union([z.null(), z.string()]).transform((v, ctx) => {
    if (v === null || normalizeText(v) === '') return null;
    const r = schema.safeParse(v);
    if (!r.success) {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
    return r.data as string | null;
  });

/** Spaces and dashes are allowed while typing; stored as 9 digits. */
const registrationNumber = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine(isValidIsraeliId);

/** Any Israeli number form; stored as E.164. */
const phone = z.string().transform((s, ctx) => {
  const e164 = toE164(s);
  if (!e164) {
    ctx.addIssue({ code: 'custom', message: 'invalid' });
    return z.NEVER;
  }
  return e164;
});

const email = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().max(BUSINESS_LIMITS.email.max).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/));

/** PUT /api/admin/settings/business body. Omitted = unchanged; null or empty = unset. */
export const businessSettingsUpdate = z
  .object({
    name: optional(text(BUSINESS_LIMITS.name.min, BUSINESS_LIMITS.name.max)).optional(),
    ownerName: optional(text(BUSINESS_LIMITS.ownerName.min, BUSINESS_LIMITS.ownerName.max)).optional(),
    registrationNumber: optional(registrationNumber).optional(),
    address: optional(text(BUSINESS_LIMITS.address.min, BUSINESS_LIMITS.address.max)).optional(),
    phone: optional(phone).optional(),
    whatsapp: optional(phone).optional(),
    email: optional(email).optional(),
    vatStatus: z.enum(VAT_STATUSES).optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'empty_update');
export type BusinessSettingsUpdate = z.infer<typeof businessSettingsUpdate>;

/** The fields of an update that failed validation, for the form to mark. */
export function invalidBusinessFields(raw: unknown): string[] {
  const r = businessSettingsUpdate.safeParse(raw);
  if (r.success) return [];
  return [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
}

/** The update as app_settings key -> JSON value, for fn_admin_set_business_details. */
export function toSettingValues(update: BusinessSettingsUpdate): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [field, value] of Object.entries(update)) {
    if (value !== undefined) out[BUSINESS_SETTING_KEYS[field as keyof typeof BUSINESS_SETTING_KEYS]] = value;
  }
  return out;
}

/** What the screen and the API show: every field, null when unset. */
export const businessSettings = z.object({
  name: z.string().nullable(),
  ownerName: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  vatStatus: z.enum(VAT_STATUSES).nullable(),
  /** False while vat_status is still the seeded default nobody confirmed (updated_by is null). */
  vatStatusConfirmed: z.boolean(),
});
export type BusinessSettings = z.infer<typeof businessSettings>;

export const BUSINESS_SETTINGS_API_ERRORS = ['unauthorized', 'forbidden_origin', 'invalid_input', 'server_error'] as const;
export const businessSettingsApiError = z.object({
  error: z.enum(BUSINESS_SETTINGS_API_ERRORS),
  fields: z.array(z.string()).optional(),
});
export type BusinessSettingsApiErrorBody = z.infer<typeof businessSettingsApiError>;
