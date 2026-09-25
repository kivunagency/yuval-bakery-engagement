import { z } from 'zod';
import { ilMobilePhone, isoDate, optionalEmail, shortText } from '@/lib/shared/contracts/primitives';

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
