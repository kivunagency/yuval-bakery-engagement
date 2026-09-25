'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { completeRegistration, signInCustomer, signOutCustomer, type SignInError } from '@/lib/server/identity/customer-auth';
import { loadMyAccount, setMyMarketingConsent, updateMyProfile, type AccountWriteError } from '@/lib/server/identity/account';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';

// Server actions for the customer account screens (client-005). Next.js
// checks every server action's Origin against the Host (CSRF, SEC-013). All
// logic lives in lib/server/identity; these read the form and route.

export type SignInState = { error: SignInError } | null;
export type AccountFormState = { ok: true } | { error: AccountWriteError; fields?: string[] } | null;

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
};

/** Day and month selects: both empty = not given; one of them empty = invalid (Zod refuses NaN). */
function dayMonth(form: FormData, prefix: string): { day: number; month: number } | null {
  const day = text(form, `${prefix}_day`);
  const month = text(form, `${prefix}_month`);
  if (!day && !month) return null;
  return { day: day ? Number(day) : Number.NaN, month: month ? Number(month) : Number.NaN };
}

export async function signInAction(_prev: SignInState, form: FormData): Promise<SignInState> {
  const result = await signInCustomer({ email: text(form, 'email'), password: text(form, 'password') });
  if (!result.ok) return { error: result.error };
  redirect('/account');
}

export async function signOutAction(): Promise<void> {
  await signOutCustomer();
  redirect('/account/login?notice=signed_out');
}

/** "Complete your details" for a confirmed user without a profile (phone taken, or nothing parked). */
export async function completeDetailsAction(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const status = await completeRegistration({
    name: text(form, 'name'),
    phone: text(form, 'phone'),
    privacy_notice_version: text(form, 'privacyNoticeVersion'),
    age_confirmed: form.get('ageConfirmed') === 'on' ? true : false,
  });
  if (status === 'created') redirect('/account/welcome');
  if (status === 'exists') redirect('/account');
  if (status === 'signed_out') redirect('/account/login');
  if (status === 'phone_taken') return { error: 'phone_taken', fields: ['phone'] };
  return { error: 'invalid_input' };
}

export async function saveProfileAction(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const account = await loadMyAccount();
  if (!account?.profile) return { error: 'signed_out' };
  const p = account.profile;
  // Dates are edited on the preferences form only (they exist only with consent).
  const result = await updateMyProfile({
    name: text(form, 'name'),
    phone: text(form, 'phone'),
    birthday: p.birthday_day && p.birthday_month ? { day: p.birthday_day, month: p.birthday_month } : null,
    anniversary: p.anniversary_day && p.anniversary_month ? { day: p.anniversary_day, month: p.anniversary_month } : null,
  });
  if (!result.ok) return { error: result.error, fields: result.fields };
  revalidatePath('/account');
  return { ok: true };
}

/**
 * The s.30A choice and the dates that depend on it. The consent change is its
 * own call to fn_set_marketing_consent (only when the box changed); the dates
 * are saved after it, and only when the box is ticked. Unticking withdraws
 * consent, which erases the dates in the DB.
 */
export async function savePreferencesAction(_prev: AccountFormState, form: FormData): Promise<AccountFormState> {
  const source = text(form, 'source') === 'registration' ? 'registration' : 'profile';
  const account = await loadMyAccount();
  if (!account?.profile) return { error: 'signed_out' };
  const p = account.profile;
  const wantsOffers = form.get('marketing') === 'on';

  if (wantsOffers !== p.marketing_opt_in) {
    const consent = await setMyMarketingConsent({ action: wantsOffers ? 'granted' : 'withdrawn', version: TEXT_VERSIONS.marketing, source });
    if (!consent.ok) return { error: consent.error };
  }
  if (wantsOffers) {
    const dates = await updateMyProfile({
      name: p.name ?? '',
      phone: p.phone,
      birthday: dayMonth(form, 'birthday'),
      anniversary: dayMonth(form, 'anniversary'),
    });
    if (!dates.ok) return { error: dates.error, fields: dates.fields };
  }
  revalidatePath('/account');
  if (source === 'registration') redirect('/account?saved=preferences');
  return { ok: true };
}
