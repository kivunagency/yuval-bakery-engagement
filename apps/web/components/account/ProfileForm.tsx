'use client';

import { useTranslations } from 'next-intl';
import { saveProfileAction, type AccountFormState } from '@/app/(public)/account/actions';
import { useFormAction } from './use-form-action';
import styles from './account.module.css';

// s.14 correction: name and phone. The email is the sign-in identity (Auth),
// changed on request only. Dates live on the preferences form (consent-bound).
export function ProfileForm({ name, phone }: { name: string; phone: string }) {
  const t = useTranslations('account');
  const tr = useTranslations('registration');
  const [state, onSubmit, pending] = useFormAction<AccountFormState>(saveProfileAction, null);
  const bad = state && 'error' in state ? (state.fields ?? []) : [];
  return (
    <form onSubmit={onSubmit} className={styles.form} noValidate data-testid="profile-form">
      {state && 'ok' in state ? (
        <p className={styles.ok} role="status">
          {t('saved')}
        </p>
      ) : null}
      {state && 'error' in state ? (
        <p className={styles.error} role="alert" data-testid="profile-error">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="profile-name">{tr('name')}</label>
        <input id="profile-name" name="name" className={styles.input} defaultValue={name} autoComplete="name" required maxLength={80} aria-invalid={bad.includes('name')} />
      </div>
      <div className={styles.field}>
        <label htmlFor="profile-phone">{tr('phone')}</label>
        <input id="profile-phone" name="phone" type="tel" dir="ltr" className={styles.input} defaultValue={phone} autoComplete="tel" inputMode="tel" required maxLength={20} aria-invalid={bad.includes('phone')} aria-describedby="profile-phone-hint" />
        <p id="profile-phone-hint" className={styles.hint}>
          {tr('phone_hint')}
        </p>
      </div>
      <p className={styles.hint}>{t('email_change_note')}</p>
      <button type="submit" className={`btn btn-secondary ${styles.submit}`} disabled={pending} aria-busy={pending}>
        {t('save')}
      </button>
    </form>
  );
}
