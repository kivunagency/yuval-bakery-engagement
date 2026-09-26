'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { isolatedDate, weekdayKey } from '@/components/day-state/format';
import { findOrderErrorBody, findOrderResponse, type FoundOrder } from '@/lib/shared/contracts/find-order';
import styles from './find-order.module.css';

type State = { kind: 'idle' } | { kind: 'found'; order: FoundOrder } | { kind: 'not_found' } | { kind: 'error'; message: string };

// The find-my-order form (US-0d). Shows only what the DB returned: the masked
// view and the confirmation PDF link. A miss says the same thing whatever was
// wrong (phone, number or both), so the screen never confirms that a phone or
// a number exists.
export function FindOrderForm() {
  const t = useTranslations('find_order');
  const td = useTranslations('day_state');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setInvalid([]);
    try {
      const res = await fetch('/api/find-order', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: String(form.get('phone') ?? ''), orderNumber: String(form.get('orderNumber') ?? '') }),
      });
      const body: unknown = await res.json().catch(() => null);
      const ok = findOrderResponse.safeParse(body);
      if (res.ok && ok.success) {
        setState(ok.data.result === 'found' ? { kind: 'found', order: ok.data.order } : { kind: 'not_found' });
        return;
      }
      const err = findOrderErrorBody.safeParse(body);
      if (err.success && err.data.error === 'invalid_input') {
        setInvalid(err.data.fields ?? []);
        setState({ kind: 'idle' });
      } else if (err.success && err.data.error === 'too_many_attempts') setState({ kind: 'error', message: t('too_many') });
      else setState({ kind: 'error', message: t('error') });
    } catch {
      setState({ kind: 'error', message: t('error') });
    } finally {
      setBusy(false);
    }
  }

  const bad = (f: string) => invalid.includes(f);
  const o = state.kind === 'found' ? state.order : null;

  return (
    <div className={styles.stack}>
      <p className={styles.notice} data-testid="find-order-privacy">
        {t('privacy')}{' '}
        <Link href="/privacy" className={styles.inlineLink}>
          {t('privacy_link')}
        </Link>
      </p>
      <form className={styles.form} onSubmit={onSubmit} noValidate data-testid="find-order-form">
        <div className={styles.field}>
          <label htmlFor="fo-phone">{t('phone_label')}</label>
          <input
            id="fo-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" required maxLength={20}
            className={styles.input} aria-invalid={bad('phone') || undefined} aria-describedby={bad('phone') ? 'fo-phone-error' : undefined}
          />
          {bad('phone') ? <p id="fo-phone-error" className={styles.error}>{t('phone_invalid')}</p> : null}
        </div>
        <div className={styles.field}>
          <label htmlFor="fo-number">{t('number_label')}</label>
          <input
            id="fo-number" name="orderNumber" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" required maxLength={24}
            className={styles.input} aria-invalid={bad('orderNumber') || undefined} aria-describedby={`fo-number-hint${bad('orderNumber') ? ' fo-number-error' : ''}`}
          />
          <p id="fo-number-hint" className={styles.hint}>{t('number_hint')}</p>
          {bad('orderNumber') ? <p id="fo-number-error" className={styles.error}>{t('number_invalid')}</p> : null}
        </div>
        <button type="submit" className={styles.submit} disabled={busy} data-testid="find-order-submit">
          {t('submit')}
        </button>
      </form>

      <div aria-live="polite" role="status">
        {state.kind === 'not_found' ? (
          <p className={styles.miss} data-testid="find-order-not-found">{t('not_found')}</p>
        ) : state.kind === 'error' ? (
          <p className={styles.error} data-testid="find-order-error">{state.message}</p>
        ) : o ? (
          <section className={styles.result} aria-labelledby="fo-result" data-testid="find-order-result">
            <h2 id="fo-result">
              {t.rich('result_title', { number: o.orderNumber, ltr: (c) => <span className="ltr">{c}</span> })}
            </h2>
            <dl>
              <div>
                <dt>{t('status_label')}</dt>
                <dd data-testid="find-order-status">{t(`status.${o.status}`)}</dd>
              </div>
              <div>
                <dt>{t('day_label')}</dt>
                <dd>{td('day_long', { weekday: td(`weekday_long.${weekdayKey(o.day)}`), date: isolatedDate(o.day) })}</dd>
              </div>
              <div>
                <dt>{t('how_label')}</dt>
                <dd>{o.fulfillment === 'delivery' ? t('delivery') : t('pickup')}</dd>
              </div>
              {o.maskedAddress ? (
                <div>
                  <dt>{t('address_label')}</dt>
                  <dd><bdi data-testid="find-order-address">{o.maskedAddress}</bdi></dd>
                </div>
              ) : null}
            </dl>
            {o.confirmationPath ? (
              <a className={styles.download} href={o.confirmationPath} download={`order-${o.orderNumber}.pdf`} rel="noreferrer" data-testid="find-order-confirmation">
                {t('download')}
              </a>
            ) : null}
            <p className={styles.hint}>{t('payment_page_hint')}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
