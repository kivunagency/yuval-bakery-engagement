import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPwnedPassword } from '@/lib/server/identity/pwned-password';
import { CUSTOMER_SESSION_MAX_AGE_SECONDS, signedInAt } from '@/lib/server/identity/customer-auth';
import { consentInput, dayMonth, profileInput, registerInput, unsubscribeToken } from '@/lib/shared/contracts/registration';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';

const valid = {
  name: 'Dana',
  phone: '050-1234567',
  email: ' Dana@Example.test ',
  password: 'twelve-chars',
  ageConfirmed: true,
  privacyNoticeVersion: TEXT_VERSIONS.privacy,
};

describe('registerInput (api-010)', () => {
  it('normalizes phone to E.164 and the email to lower case', () => {
    expect(registerInput.parse(valid)).toMatchObject({ phone: '+972501234567', email: 'dana@example.test' });
  });
  it('refuses marketing consent riding along with registration (s.30A: separate act)', () => {
    expect(registerInput.safeParse({ ...valid, marketingOptIn: true }).success).toBe(false);
    expect(registerInput.safeParse({ ...valid, marketing: 'granted' }).success).toBe(false);
  });
  it('requires the age declaration and the privacy version this build shows', () => {
    expect(registerInput.safeParse({ ...valid, ageConfirmed: false }).success).toBe(false);
    expect(registerInput.safeParse({ ...valid, privacyNoticeVersion: 'privacy-2020-01-v0' }).success).toBe(false);
  });
  it('SEC-014: 12 to 72 characters', () => {
    expect(registerInput.safeParse({ ...valid, password: 'x'.repeat(11) }).success).toBe(false);
    expect(registerInput.safeParse({ ...valid, password: 'x'.repeat(73) }).success).toBe(false);
    expect(registerInput.safeParse({ ...valid, password: 'x'.repeat(72) }).success).toBe(true);
  });
});

describe('dayMonth (no year, compliance-spec section 3)', () => {
  it.each([[29, 2], [31, 1], [30, 4], [31, 12]])('accepts %i/%i', (day, month) => {
    expect(dayMonth.safeParse({ day, month }).success).toBe(true);
  });
  it.each([[30, 2], [31, 4], [0, 1], [1, 13], [31, 6]])('refuses %i/%i', (day, month) => {
    expect(dayMonth.safeParse({ day, month }).success).toBe(false);
  });
  it('profile dates are optional', () => {
    expect(profileInput.safeParse({ name: 'D', phone: '0501234567', birthday: null, anniversary: null }).success).toBe(true);
  });
});

describe('consentInput', () => {
  it('only the current marketing version, only customer sources', () => {
    expect(consentInput.safeParse({ action: 'granted', version: TEXT_VERSIONS.marketing, source: 'registration' }).success).toBe(true);
    expect(consentInput.safeParse({ action: 'granted', version: 'marketing-2020-01-v0', source: 'profile' }).success).toBe(false);
    expect(consentInput.safeParse({ action: 'granted', version: TEXT_VERSIONS.marketing, source: 'admin_on_request' }).success).toBe(false);
    expect(consentInput.safeParse({ action: 'granted', version: TEXT_VERSIONS.marketing, source: 'unsubscribe_link' }).success).toBe(false);
  });
});

describe('unsubscribeToken', () => {
  it('is 32 lower-case hex characters', () => {
    expect(unsubscribeToken.safeParse('0123456789abcdef0123456789abcdef').success).toBe(true);
    expect(unsubscribeToken.safeParse("0123456789abcdef0123456789abcde'").success).toBe(false);
  });
});

describe('checkPwnedPassword (SEC-014, k-anonymity)', () => {
  const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();
  const fake = (body: string, status = 200) => {
    const seen: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(body, { status });
    }) as typeof fetch;
    return { impl, seen };
  };

  it('sends only the 5-character prefix and finds the suffix', async () => {
    const h = sha1('password1234');
    const { impl, seen } = fake(`0000000000000000000000000000000000A:0\r\n${h.slice(5)}:42\r\n`);
    expect(await checkPwnedPassword('password1234', impl)).toBe('pwned');
    expect(seen).toEqual([`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`]);
    expect(seen[0]).not.toContain(h.slice(5));
  });
  it('a padding line with count 0 is not a hit', async () => {
    const h = sha1('a-unique-passphrase');
    expect(await checkPwnedPassword('a-unique-passphrase', fake(`${h.slice(5)}:0\r\n`).impl)).toBe('clean');
  });
  it('fails open as unknown when the API errors or is unreachable', async () => {
    expect(await checkPwnedPassword('x', fake('', 503).impl)).toBe('unknown');
    const throwing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await checkPwnedPassword('x', throwing)).toBe('unknown');
  });
});

describe('signedInAt (14-day customer session cap, SEC-013)', () => {
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  it('takes the earliest authentication time', () => {
    expect(signedInAt(jwt({ amr: [{ method: 'password', timestamp: 1790000000 }, { method: 'otp', timestamp: 1789000000 }] }))).toBe(1789000000);
  });
  it('is null without amr or for a malformed token', () => {
    expect(signedInAt(jwt({}))).toBeNull();
    expect(signedInAt('garbage')).toBeNull();
  });
  it('the cap is 14 days', () => {
    expect(CUSTOMER_SESSION_MAX_AGE_SECONDS).toBe(1_209_600);
  });
});
