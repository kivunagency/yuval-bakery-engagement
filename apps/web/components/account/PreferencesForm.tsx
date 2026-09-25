'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { savePreferencesAction, type AccountFormState } from '@/app/(public)/account/actions';
import { useFormAction } from './use-form-action';
import styles from './account.module.css';

// The s.30A marketing choice (compliance-spec section 5): its own checkbox,
// never ticked in advance, explicit about what, which channel, and that it can
// be undone; saving without it is always possible. Birthday and anniversary
// sit under it with their purpose, and are enabled only while it is ticked,
// because the DB keeps them only with consent.

export type DayMonthValue = { day: number | null; month: number | null };

type Props = {
  source: 'registration' | 'profile';
  businessName: string;
  optedIn: boolean;
  birthday: DayMonthValue;
  anniversary: DayMonthValue;
  monthNames: string[];
};

export function PreferencesForm({ source, businessName, optedIn, birthday, anniversary, monthNames }: Props) {
  const t = useTranslations('registration');
  const ta = useTranslations('account');
  const [state, onSubmit, pending] = useFormAction<AccountFormState>(savePreferencesAction, null);
  const [offers, setOffers] = useState(optedIn);

  function dayMonth(prefix: 'birthday' | 'anniversary', label: string, value: DayMonthValue) {
    return (
      <fieldset className={styles.fieldset} data-testid={`${prefix}-fields`}>
        <legend className={styles.legend}>{label}</legend>
        <div className={styles.dayMonth}>
          <div className={styles.field}>
            <label htmlFor={`${prefix}-day`}>{t('day')}</label>
            <select id={`${prefix}-day`} name={`${prefix}_day`} className={styles.select} defaultValue={value.day ?? ''}>
              <option value="">{t('no_value')}</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${prefix}-month`}>{t('month')}</label>
            <select id={`${prefix}-month`} name={`${prefix}_month`} className={styles.select} defaultValue={value.month ?? ''}>
              <option value="">{t('no_value')}</option>
              {monthNames.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>
    );
  }

  return (
    <form onSubmit={onSubmit} className={styles.form} noValidate data-testid="preferences-form">
      <input type="hidden" name="source" value={source} />
      {state && 'ok' in state ? (
        <p className={styles.ok} role="status" data-testid="preferences-saved">
          {t('saved')}
        </p>
      ) : null}
      {state && 'error' in state ? (
        <p className={styles.error} role="alert" data-testid="preferences-error">
          {ta(`errors.${state.error}`)}
        </p>
      ) : null}
      <div className={styles.field}>
        <label className={styles.check} htmlFor={`marketing-${source}`}>
          <input
            id={`marketing-${source}`}
            name="marketing"
            type="checkbox"
            defaultChecked={optedIn}
            onChange={(e) => setOffers(e.currentTarget.checked)}
            aria-describedby={`marketing-${source}-hint`}
            data-testid="marketing-optin"
          />
          <span>{t('marketing_optin_label', { businessName })}</span>
        </label>
        <p id={`marketing-${source}-hint`} className={styles.hint}>
          {t('marketing_optin_hint')}
        </p>
      </div>
      <fieldset className={styles.fieldset} disabled={!offers} aria-describedby={`dates-${source}-purpose`} data-testid="dates-fieldset">
        <legend className={styles.legend}>{t('dates_title')}</legend>
        <p id={`dates-${source}-purpose`} className={styles.hint} data-testid="dates-purpose">
          {t('purpose_note')}
          {offers ? null : ` ${t('dates_need_optin')}`}
        </p>
        {dayMonth('birthday', t('birthday_optional'), birthday)}
        {dayMonth('anniversary', t('anniversary_optional'), anniversary)}
      </fieldset>
      <div className={styles.actions}>
        <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={pending} aria-busy={pending}>
          {t('save_preferences')}
        </button>
        {source === 'registration' ? (
          <Link href="/account" className={`btn btn-secondary ${styles.submit}`} data-testid="preferences-skip">
            {t('skip')}
          </Link>
        ) : null}
      </div>
    </form>
  );
}
