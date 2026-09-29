import { z } from 'zod';

// Admin login forms (db-005). Limits keep oversized input away from Auth.

export const adminLoginInput = z.object({
  email: z.string().trim().max(254).pipe(z.email()),
  password: z.string().min(1).max(200),
});

/** A 6-digit TOTP code, spaces tolerated (authenticator apps show "123 456"). */
export const totpCode = z
  .string()
  .max(20)
  .transform((s) => s.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/));

export const adminTotpInput = z.object({
  code: totpCode,
  factorId: z.uuid().optional(),
});
