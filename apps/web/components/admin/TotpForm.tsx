'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { verifyTotpAction, type AdminAuthFormState } from '@/app/(admin-auth)/admin/login/actions';

/** The 6-digit code form, for first-time enrolment (with factorId) and for every later login. */
export function TotpForm({ factorId, submitLabel }: { factorId?: string; submitLabel: string }) {
  const t = useTranslations('admin.login');
  const [state, action, pending] = useActionState<AdminAuthFormState, FormData>(verifyTotpAction, null);
  return (
    <form action={action} className="admin-form" noValidate>
      {state?.error ? (
        <p className="admin-form-error" role="alert" data-testid="totp-error">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      {factorId ? <input type="hidden" name="factorId" value={factorId} /> : null}
      <div className="admin-field">
        <label htmlFor="code">{t('code_label')}</label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          dir="ltr"
          className="num admin-code-input"
          aria-describedby="code-hint"
          required
        />
        <p id="code-hint" className="admin-hint">
          {t('code_hint')}
        </p>
      </div>
      <button type="submit" className="btn btn-primary admin-submit" disabled={pending}>
        {submitLabel}
      </button>
    </form>
  );
}
