'use client';

import { useTranslations } from 'next-intl';
import { signInAction, type SignInState } from '@/app/(public)/account/actions';
import { useFormAction } from './use-form-action';
import styles from './account.module.css';

export function SignInForm() {
  const t = useTranslations('account');
  const [state, onSubmit, pending] = useFormAction<SignInState>(signInAction, null);
  return (
    <form onSubmit={onSubmit} className={styles.form} noValidate data-testid="signin-form">
      {state?.error ? (
        <p className={styles.error} role="alert" data-testid="signin-error">
          {t(`login_errors.${state.error}`)}
        </p>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="signin-email">{t('login_email')}</label>
        <input id="signin-email" name="email" type="email" dir="ltr" className={styles.input} autoComplete="username" inputMode="email" required maxLength={254} />
      </div>
      <div className={styles.field}>
        <label htmlFor="signin-password">{t('login_password')}</label>
        <input id="signin-password" name="password" type="password" dir="ltr" className={styles.input} autoComplete="current-password" required maxLength={200} />
      </div>
      <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={pending} aria-busy={pending}>
        {t('login_submit')}
      </button>
    </form>
  );
}
