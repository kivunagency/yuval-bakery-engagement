'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { loginAction, type AdminAuthFormState } from '@/app/(admin-auth)/admin/login/actions';

export function LoginForm() {
  const t = useTranslations('admin.login');
  const [state, action, pending] = useActionState<AdminAuthFormState, FormData>(loginAction, null);
  return (
    <form action={action} className="admin-form" noValidate>
      {state?.error ? (
        <p className="admin-form-error" role="alert" data-testid="login-error">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      <div className="admin-field">
        <label htmlFor="email">{t('email')}</label>
        <input id="email" name="email" type="email" autoComplete="username" inputMode="email" dir="ltr" required maxLength={254} />
      </div>
      <div className="admin-field">
        <label htmlFor="password">{t('password')}</label>
        <input id="password" name="password" type="password" autoComplete="current-password" dir="ltr" required maxLength={200} />
      </div>
      <button type="submit" className="btn btn-primary admin-submit" disabled={pending}>
        {t('submit')}
      </button>
    </form>
  );
}
