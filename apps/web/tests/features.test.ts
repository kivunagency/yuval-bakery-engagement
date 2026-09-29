import { describe, expect, it } from 'vitest';
import { readFeatures } from '@/lib/server/features';

// Customer email and customer accounts wait for a verified sending domain.
describe('readFeatures', () => {
  it('unset: on for the local stack, off in dev and prod', () => {
    expect(readFeatures({ APP_ENV: 'local' })).toEqual({ customerEmail: true, customerAccounts: true });
    expect(readFeatures({})).toEqual({ customerEmail: true, customerAccounts: true });
    expect(readFeatures({ APP_ENV: 'dev' })).toEqual({ customerEmail: false, customerAccounts: false });
    expect(readFeatures({ APP_ENV: 'prod', CUSTOMER_EMAIL_ENABLED: '', CUSTOMER_ACCOUNTS_ENABLED: '' })).toEqual({ customerEmail: false, customerAccounts: false });
  });

  it('explicit values win, each flag on its own', () => {
    expect(readFeatures({ APP_ENV: 'prod', CUSTOMER_EMAIL_ENABLED: 'true' })).toEqual({ customerEmail: true, customerAccounts: false });
    expect(readFeatures({ APP_ENV: 'local', CUSTOMER_ACCOUNTS_ENABLED: 'false' })).toEqual({ customerEmail: true, customerAccounts: false });
  });

  it('anything but "true" is off, and a bad value never throws', () => {
    expect(readFeatures({ APP_ENV: 'dev', CUSTOMER_EMAIL_ENABLED: 'yes', CUSTOMER_ACCOUNTS_ENABLED: 'TRUE' })).toEqual({ customerEmail: false, customerAccounts: false });
    expect(readFeatures({ APP_ENV: 'staging' })).toEqual({ customerEmail: false, customerAccounts: false });
  });
});
