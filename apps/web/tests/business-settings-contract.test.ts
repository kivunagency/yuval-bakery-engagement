import { describe, expect, it } from 'vitest';
import { businessSettingsUpdate, invalidBusinessFields, isValidIsraeliId, toSettingValues } from '@/lib/shared/contracts/business-settings';

// settings-business: the contract the screen and PUT /api/admin/settings/business
// share. The DB (fn_admin_set_business_details) repeats every rule; the
// regression spec checks the DB side through the real route.
describe('business settings contract', () => {
  it('check digit: valid and invalid 9-digit numbers', () => {
    for (const ok of ['000000018', '123456782', '111111118']) expect(isValidIsraeliId(ok), ok).toBe(true);
    for (const bad of ['123456789', '000000000', '12345678', '1234567890', '12345678a', '']) expect(isValidIsraeliId(bad), bad).toBe(false);
  });

  it('normalizes: trims, collapses spaces, phones to E.164, osek number without dashes, empty = unset', () => {
    const r = businessSettingsUpdate.parse({
      name: '  QA   Bakery ',
      registrationNumber: '12345-678 2',
      phone: '050-123-4567',
      whatsapp: '+972 52 765 4321',
      email: ' shop@example.com ',
      address: '',
      ownerName: null,
    });
    expect(r).toEqual({
      name: 'QA Bakery',
      registrationNumber: '123456782',
      phone: '+972501234567',
      whatsapp: '+972527654321',
      email: 'shop@example.com',
      address: null,
      ownerName: null,
    });
    expect(toSettingValues(r)).toEqual({
      business_name: 'QA Bakery',
      business_registration_number: '123456782',
      business_phone: '+972501234567',
      business_whatsapp: '+972527654321',
      business_email: 'shop@example.com',
      business_address: null,
      business_owner_name: null,
    });
  });

  it('refuses bad values and names the fields', () => {
    expect(invalidBusinessFields({ name: 'x' })).toEqual(['name']);
    expect(invalidBusinessFields({ name: 'a'.repeat(61) })).toEqual(['name']);
    expect(invalidBusinessFields({ registrationNumber: '123456789' })).toEqual(['registrationNumber']);
    expect(invalidBusinessFields({ phone: '12345' })).toEqual(['phone']);
    expect(invalidBusinessFields({ phone: '+1 212 555 0100' })).toEqual(['phone']);
    expect(invalidBusinessFields({ email: 'not-an-email' })).toEqual(['email']);
    expect(invalidBusinessFields({ address: 'abc' })).toEqual(['address']);
    expect(invalidBusinessFields({ name: 'Name\u0007Shop' })).toEqual(['name']);
    expect(invalidBusinessFields({ vatStatus: 'other' })).toEqual(['vatStatus']);
    expect(invalidBusinessFields({ name: 'Valid name', phone: 'x', email: 'y' })).toEqual(['phone', 'email']);
  });

  it('strict: unknown keys and an empty update are refused; vat_status cannot be unset', () => {
    expect(businessSettingsUpdate.safeParse({ business_name: 'x' }).success).toBe(false);
    expect(businessSettingsUpdate.safeParse({ name: 'Valid name', updatedBy: 'someone' }).success).toBe(false);
    expect(businessSettingsUpdate.safeParse({}).success).toBe(false);
    expect(businessSettingsUpdate.safeParse({ vatStatus: null }).success).toBe(false);
    expect(businessSettingsUpdate.safeParse({ vatStatus: 'licensed' }).success).toBe(true);
  });
});
