import { z } from 'zod';
import { ilMobilePhone, isoDate, minutes, money, optionalEmail, shortText } from '@/lib/shared/contracts/primitives';

// Contracts for the custom-cake request (api-005, PRD US-2). Lengths are
// SEC-025's (name 60, inscription 120, notes 500); the DB repeats them as
// CHECKs (migration 20260926080000).

export const CUSTOM_CAKE_LIMITS = {
  name: 60,
  inscription: 120,
  notes: 500,
  photos: 3,
  /** Bucket-level cap too (threat-model 3.2). */
  photoBytes: 10 * 1024 * 1024,
} as const;

/** What the bucket and the server accept. SVG, GIF, PDF, HEIC are refused. */
export const CUSTOM_CAKE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const customCakePhotoMeta = z.object({
  type: z.enum(CUSTOM_CAKE_PHOTO_TYPES),
  size: z.number().int().min(1).max(CUSTOM_CAKE_LIMITS.photoBytes),
});

export const customCakeSubmit = z.strictObject({
  name: z.string().trim().min(1).max(CUSTOM_CAKE_LIMITS.name),
  phone: ilMobilePhone,
  email: optionalEmail.optional(),
  whatsappFollowupOk: z.boolean().default(false),
  inscription: shortText(CUSTOM_CAKE_LIMITS.inscription).default(''),
  notes: shortText(CUSTOM_CAKE_LIMITS.notes).default(''),
  desiredDate: isoDate,
  /** compliance-spec 11: mandatory, stored as upload_rights_confirmed_at. */
  uploadRightsConfirmed: z.literal(true),
  photos: z.array(customCakePhotoMeta).max(CUSTOM_CAKE_LIMITS.photos).default([]),
});
export type CustomCakeSubmit = z.infer<typeof customCakeSubmit>;

/** One direct-to-Storage upload the browser performs: PUT the file to this signed, single-use URL. */
export const customCakeUploadTarget = z.object({ url: z.url() });

export const customCakeSubmitResponse = z.object({
  requestId: z.uuid(),
  uploads: z.array(customCakeUploadTarget),
  /** True when photos were asked for but Storage could not issue upload URLs. */
  photosUnavailable: z.boolean(),
});
export type CustomCakeSubmitResponse = z.infer<typeof customCakeSubmitResponse>;

export const customCakePhotosResponse = z.object({ accepted: z.number().int(), rejected: z.number().int() });
export type CustomCakePhotosResponse = z.infer<typeof customCakePhotosResponse>;

export type CustomCakeSubmitError =
  | 'invalid_input'
  | 'lead_time_not_met'
  | 'rate_limited'
  | 'unavailable';
export type CustomCakeApiErrorBody = { error: CustomCakeSubmitError | 'not_found' | 'upload_closed' };

// ---- Admin (api-006, client-008) -------------------------------------------

export const customCakeApprove = z.strictObject({
  price: money.refine((v) => v > 0, 'price_positive'),
  ovenMinutes: minutes,
  workMinutes: minutes,
});
export type CustomCakeApprove = z.infer<typeof customCakeApprove>;

export const customCakeDecline = z.strictObject({
  /** Written by Yuval only (threat-model 3.5); optional (PRD US-2). */
  reason: shortText(300).default(''),
});

export const customCakeCapacityQuery = z.strictObject({
  oven: z.coerce.number().pipe(minutes),
  work: z.coerce.number().pipe(minutes),
});

/** fn_admin_custom_cake_capacity_check, as the DB returns it. */
export const capacityCheckRow = z.object({
  day: isoDate,
  day_passed: z.boolean(),
  has_day: z.boolean(),
  is_blackout: z.boolean(),
  fits: z.boolean(),
  oven_minutes_total: z.number().int().nullable(),
  oven_minutes_left: z.number().int().nullable(),
  work_minutes_total: z.number().int().nullable(),
  work_minutes_left: z.number().int().nullable(),
  oven_minutes_unpaid_left: z.number().int().nullable(),
  work_minutes_unpaid_left: z.number().int().nullable(),
});

export type CustomCakeCapacityCheck = {
  day: string;
  dayPassed: boolean;
  hasDay: boolean;
  isBlackout: boolean;
  fits: boolean;
  ovenMinutesLeft: number | null;
  workMinutesLeft: number | null;
  ovenMinutesUnpaidLeft: number | null;
  workMinutesUnpaidLeft: number | null;
};

export function toCapacityCheck(r: z.infer<typeof capacityCheckRow>): CustomCakeCapacityCheck {
  return {
    day: r.day,
    dayPassed: r.day_passed,
    hasDay: r.has_day,
    isBlackout: r.is_blackout,
    fits: r.fits,
    ovenMinutesLeft: r.oven_minutes_left,
    workMinutesLeft: r.work_minutes_left,
    ovenMinutesUnpaidLeft: r.oven_minutes_unpaid_left,
    workMinutesUnpaidLeft: r.work_minutes_unpaid_left,
  };
}

export type CustomCakeApproveResponse = {
  orderId: string;
  orderNumber: string;
  total: number;
  paymentPendingExpiresAt: string;
  /** Guest payment page with the one-time capability token; shown once, never stored in clear. */
  paymentPageUrl: string;
  /** wa.me link to the requester with the approval message (click-to-send, US-11); null if the phone is not a valid number. */
  whatsappHref: string | null;
};

export type CustomCakeDeclineResponse = { declined: true; whatsappHref: string | null };

export type CustomCakeAdminError =
  | 'unauthorized'
  | 'forbidden_origin'
  | 'invalid_input'
  | 'not_found'
  | 'not_pending'
  | 'capacity_changed'
  | 'unavailable';
export type CustomCakeAdminErrorBody = { error: CustomCakeAdminError; check?: CustomCakeCapacityCheck };

/** One pending request as the admin queue shows it (client-008). */
export type QueuePhoto = { path: string; url: string | null };
export type QueueItem = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  whatsappOk: boolean;
  inscription: string | null;
  notes: string | null;
  desiredDate: string;
  createdAt: string;
  photos: QueuePhoto[];
};
