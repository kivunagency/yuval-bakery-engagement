'use server';

import { redirect } from 'next/navigation';
import { adminSignOut, passwordLogin, verifyTotp, type AdminAuthError } from '@/lib/server/auth/admin-login';

// Server actions for the admin login screens. Next.js checks the Origin of
// every server action against the Host (CSRF, SEC-013). All logic lives in
// lib/server/auth/admin-login.ts; these only route to the next screen.

export type AdminAuthFormState = { error: AdminAuthError } | null;

export async function loginAction(_prev: AdminAuthFormState, form: FormData): Promise<AdminAuthFormState> {
  const result = await passwordLogin({ email: form.get('email'), password: form.get('password') });
  if (!result.ok) return { error: result.error };
  redirect(result.next === 'totp' ? '/admin/login/verify' : '/admin/login/enroll');
}

export async function verifyTotpAction(_prev: AdminAuthFormState, form: FormData): Promise<AdminAuthFormState> {
  const factorId = form.get('factorId');
  const result = await verifyTotp({ code: form.get('code'), factorId: typeof factorId === 'string' && factorId ? factorId : undefined });
  if (!result.ok) {
    if (result.error === 'session_expired') redirect('/admin/login');
    return { error: result.error };
  }
  redirect('/admin');
}

export async function signOutAction(): Promise<void> {
  await adminSignOut();
  redirect('/admin/login');
}
