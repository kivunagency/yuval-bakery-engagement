import { z } from 'zod';

// Building blocks for the per-endpoint Zod contracts (shared-002). Each API
// task adds lib/shared/contracts/<domain>.ts with its request/response schemas
// and imports these. Every free-text field has a max length (SEC-025).

export const uuid = z.uuid();

/** YYYY-MM-DD that is a real calendar date. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'invalid_date');

/**
 * Israeli mobile number (US-0: mandatory for guests), normalized to E.164
 * (+9725XXXXXXXX), which is the form stored in the DB. Accepts 05X-XXXXXXX,
 * 05XXXXXXXX, +9725..., 9725..., with spaces or dashes.
 */
export const ilMobilePhone = z
  .string()
  .max(20)
  .transform((raw) => raw.replace(/[\s-]/g, ''))
  .transform((s) => (s.startsWith('+972') ? s.slice(4) : s.startsWith('972') ? s.slice(3) : s.startsWith('0') ? s.slice(1) : s))
  .refine((local) => /^5\d{8}$/.test(local), 'invalid_il_mobile')
  .transform((local) => `+972${local}`);

export const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .transform((s) => (s === '' ? undefined : s))
  .pipe(z.email().optional());

export const shortText = (max: number) => z.string().trim().max(max);
export const personName = z.string().trim().min(1).max(80);

/** Non-negative money with at most 2 decimals. */
export const money = z.number().nonnegative().max(100_000).multipleOf(0.01);
export const minutes = z.number().int().min(0).max(24 * 60);
export const quantity = z.number().int().min(1).max(100);
