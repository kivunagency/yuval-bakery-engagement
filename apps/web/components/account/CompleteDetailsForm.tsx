'use client';

import { useTranslations } from 'next-intl';
import { completeDetailsAction, type AccountFormState } from '@/app/(public)/account/actions';
import { useFormAction } from './use-form-action';
import styles from './account.module.css';

export function CompleteDetailsForm({ privacyNoticeVersion }: { privacyNoticeVersion: string }) {
  const t = useTranslations('account');
  const tr = useTranslations('registration');
  const [state, onSubmit, pending] = useFormAction<AccountFormState>(completeDetailsAction, null);
  const bad = state && 'error' in state ? (state.fields ?? []) : [];
  return (
    <form onSubmit={onSubmit} className={styles.form} noValidate data-testid="complete-form">
      {state && 'error' in state ? (
        <p className={styles.error} role="alert" data-testid="complete-error">
          {t(`errors.${state.error}`)}
        </p>
      ) : null}
      <input type="hidden" name="privacyNoticeVersion" value={privacyNoticeVersion} />
      <div className={styles.field}>
        <label htmlFor="complete-name">{tr('name')}</label>
        <input id="complete-name" name="name" className={styles.input} autoComplete="name" required maxLength={80} />
      </div>
      <div className={styles.field}>
        <label htmlFor="complete-phone">{tr('phone')}</label>
        <input id="complete-phone" name="phone" type="tel" dir="ltr" className={styles.input} autoComplete="tel" inputMode="tel" required maxLength={20} aria-invalid={bad.includes('phone')} aria-describedby="complete-phone-hint" />
        <p id="complete-phone-hint" className={styles.hint}>
          {tr('phone_hint')}
        </p>
      </div>
      <label className={styles.check} htmlFor="complete-age">
        <input id="complete-age" name="ageConfirmed" type="checkbox" required />
        <span>{tr('age_confirm')}</span>
      </label>
      <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={pending} aria-busy={pending}>
        {t('complete_submit')}
      </button>
    </form>
  );
}
