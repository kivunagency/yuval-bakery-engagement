'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { RegisterErrorCode } from '@/lib/shared/contracts/registration';
import styles from './account.module.css';

// Registration form (client-005). Posts to POST /api/customers (api-010).
// No marketing checkbox here on purpose: the s.30A choice is its own act,
// offered once the email is confirmed (/account/welcome) and in the profile.
// The answer is the same for every address (no enumeration), so the screen
// only ever says "check your email".

const FIELDS = ['name', 'phone', 'email', 'password', 'ageConfirmed'] as const;
type Field = (typeof FIELDS)[number];

export function RegisterForm({ privacyNoticeVersion }: { privacyNoticeVersion: string }) {
  const t = useTranslations('registration');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<RegisterErrorCode | null>(null);
  const [bad, setBad] = useState<Field[]>([]);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    setPending(true);
    setError(null);
    setBad([]);
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          phone: form.get('phone'),
          email,
          password: form.get('password'),
          ageConfirmed: form.get('ageConfirmed') === 'on',
          privacyNoticeVersion,
        }),
      });
      if (res.status === 202) {
        setSentTo(email);
        requestAnimationFrame(() => doneRef.current?.focus());
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: RegisterErrorCode; fields?: string[] };
      setError(body.error ?? 'unavailable');
      setBad((body.fields ?? []).filter((f): f is Field => (FIELDS as readonly string[]).includes(f)));
      requestAnimationFrame(() => errorRef.current?.focus());
    } catch {
      setError('unavailable');
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <section className={styles.card} role="status" data-testid="register-check-email">
        <h2 ref={doneRef} tabIndex={-1}>
          {t('check_email_title')}
        </h2>
        <p className={styles.lead}>{t.rich('check_email_body', { email: sentTo, addr: (chunks) => <bdi dir="ltr">{chunks}</bdi> })}</p>
        <p className={styles.hint}>{t('check_email_spam')}</p>
      </section>
    );
  }

  const invalid = (f: Field) => bad.includes(f);
  const describedBy = (f: Field, hint?: string) => [hint, invalid(f) ? `${f}-error` : null].filter(Boolean).join(' ') || undefined;
  const fieldError = (f: Field) =>
    invalid(f) ? (
      <p id={`${f}-error`} className={styles.fieldError}>
        {t(`errors.field_${f}`)}
      </p>
    ) : null;

  return (
    <form className={styles.form} onSubmit={submit} noValidate data-testid="register-form">
      {error ? (
        <p ref={errorRef} tabIndex={-1} className={styles.error} role="alert" data-testid="register-error">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="reg-name">{t('name')}</label>
        <input id="reg-name" name="name" className={styles.input} autoComplete="name" required maxLength={80} aria-invalid={invalid('name')} aria-describedby={describedBy('name')} />
        {fieldError('name')}
      </div>
      <div className={styles.field}>
        <label htmlFor="reg-phone">{t('phone')}</label>
        <input id="reg-phone" name="phone" type="tel" dir="ltr" className={styles.input} autoComplete="tel" inputMode="tel" required maxLength={20} aria-invalid={invalid('phone')} aria-describedby={describedBy('phone', 'reg-phone-hint')} />
        <p id="reg-phone-hint" className={styles.hint}>
          {t('phone_hint')}
        </p>
        {fieldError('phone')}
      </div>
      <div className={styles.field}>
        <label htmlFor="reg-email">{t('email')}</label>
        <input id="reg-email" name="email" type="email" dir="ltr" className={styles.input} autoComplete="email" inputMode="email" required maxLength={254} aria-invalid={invalid('email')} aria-describedby={describedBy('email', 'reg-email-hint')} />
        <p id="reg-email-hint" className={styles.hint}>
          {t('email_hint')}
        </p>
        {fieldError('email')}
      </div>
      <div className={styles.field}>
        <label htmlFor="reg-password">{t('password')}</label>
        <input id="reg-password" name="password" type="password" dir="ltr" className={styles.input} autoComplete="new-password" required minLength={12} maxLength={72} aria-invalid={invalid('password')} aria-describedby={describedBy('password', 'reg-password-hint')} />
        <p id="reg-password-hint" className={styles.hint}>
          {t('password_hint')}
        </p>
        {fieldError('password')}
      </div>
      <div className={styles.field}>
        <label className={styles.check} htmlFor="reg-age">
          <input id="reg-age" name="ageConfirmed" type="checkbox" required aria-invalid={invalid('ageConfirmed')} aria-describedby={describedBy('ageConfirmed')} />
          <span>{t('age_confirm')}</span>
        </label>
        {fieldError('ageConfirmed')}
      </div>
      <p className={styles.hint} data-testid="consent-later-note">
        {t('consent_later_note')}
      </p>
      <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={pending} aria-busy={pending}>
        {pending ? t('submitting') : t('submit')}
      </button>
      <p className={styles.lead}>
        {t('have_account')}{' '}
        <Link className={styles.link} href="/account/login">
          {t('sign_in_link')}
        </Link>
      </p>
    </form>
  );
}
