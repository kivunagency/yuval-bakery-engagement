import { describe, expect, it } from 'vitest';
import { totpVerifiedAt } from '@/lib/server/auth/admin';
import { adminLoginInput, adminTotpInput } from '@/lib/shared/contracts/admin-auth';

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('totpVerifiedAt (12h admin session cap, SEC-013)', () => {
  it('reads the totp step time from the amr claim', () => {
    expect(totpVerifiedAt(jwt({ amr: [{ method: 'totp', timestamp: 1790000000 }, { method: 'password', timestamp: 1789999000 }] }))).toBe(1790000000);
  });
  it('is null without a totp step, or for a malformed token', () => {
    expect(totpVerifiedAt(jwt({ amr: [{ method: 'password', timestamp: 1 }] }))).toBeNull();
    expect(totpVerifiedAt('not-a-jwt')).toBeNull();
    expect(totpVerifiedAt('a.%%%.b')).toBeNull();
  });
});

describe('admin auth contracts', () => {
  it('accepts a normal login and trims the email', () => {
    expect(adminLoginInput.parse({ email: ' a@b.co ', password: 'x' })).toEqual({ email: 'a@b.co', password: 'x' });
  });
  it('rejects missing, oversized or non-string input', () => {
    expect(adminLoginInput.safeParse({ email: null, password: 'x' }).success).toBe(false);
    expect(adminLoginInput.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
    expect(adminLoginInput.safeParse({ email: 'a@b.co', password: 'x'.repeat(201) }).success).toBe(false);
  });
  it('TOTP code: 6 digits, spaces allowed, factor id optional uuid', () => {
    expect(adminTotpInput.parse({ code: '123 456' })).toEqual({ code: '123456' });
    expect(adminTotpInput.safeParse({ code: '12345' }).success).toBe(false);
    expect(adminTotpInput.safeParse({ code: '12345a' }).success).toBe(false);
    expect(adminTotpInput.safeParse({ code: '123456', factorId: 'x' }).success).toBe(false);
  });
});
