import { describe, expect, it } from 'vitest';
import { ilMobilePhone, isoDate, optionalEmail } from '@/lib/shared/contracts/primitives';

describe('ilMobilePhone', () => {
  it.each(['050-1234567', '0501234567', '+972501234567', '972501234567', '050 123 4567'])('normalizes %s to E.164', (raw) => {
    expect(ilMobilePhone.parse(raw)).toBe('+972501234567');
  });
  it.each(['03-1234567', '12345', '+97250123456', '0501234567890', ''])('rejects %s', (raw) => {
    expect(ilMobilePhone.safeParse(raw).success).toBe(false);
  });
});

describe('isoDate', () => {
  it('accepts a real date and rejects an impossible one', () => {
    expect(isoDate.safeParse('2026-02-28').success).toBe(true);
    expect(isoDate.safeParse('2026-02-30').success).toBe(false);
    expect(isoDate.safeParse('2026-2-3').success).toBe(false);
  });
});

describe('optionalEmail', () => {
  it('treats empty as absent and validates otherwise', () => {
    expect(optionalEmail.parse('')).toBeUndefined();
    expect(optionalEmail.parse(' a@b.co ')).toBe('a@b.co');
    expect(optionalEmail.safeParse('nope').success).toBe(false);
  });
});
