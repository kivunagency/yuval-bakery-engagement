'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  invalidPaymentFields,
  type PaymentLinkSettings,
  type PaymentLinksUpdateResponse,
  type PaymentSettingsApiErrorBody,
} from '@/lib/shared/contracts/payment-settings';
import type { PaymentMethod } from '@/lib/shared/payment/links';

// Bit and PayBox links (settings-payment, SEC-009). Saving asks for a fresh
// code from the authenticator app even inside a signed-in session; the DB
// refuses the change without it. Only changed links are sent; every change
// is audited and emailed to every admin.

const METHODS: readonly PaymentMethod[] = ['bit', 'paybox'];

export function PaymentLinksForm({ settings, updatedAt }: { settings: PaymentLinkSettings; updatedAt: Record<PaymentMethod, string | null> }) {
  const t = useTranslations('admin.settings.payment');
  const router = useRouter();
  const id = useId();
  const [values, setValues] = useState<Record<PaymentMethod, string>>({ bit: settings.bit.value ?? '', paybox: settings.paybox.value ?? '' });
  const [dirty, setDirty] = useState<Set<PaymentMethod>>(new Set());
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (dirty.size === 0) {
      setMessage({ kind: 'ok', text: t('nothing_changed') });
      return;
    }
    const body: Record<string, string | null> = { code: code.trim() };
    for (const m of dirty) body[m] = values[m].trim() === '' ? null : values[m].trim();
    const bad = invalidPaymentFields(body);
    setInvalid(new Set(bad));
    if (bad.length > 0) {
      setMessage({ kind: 'error', text: bad.includes('code') && bad.length === 1 ? t('error_code_format') : t('error_fields') });
      document.getElementById(`${id}-${bad[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/settings/payment-links', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      setCode('');
      if (res.ok) {
        const r = (await res.json()) as PaymentLinksUpdateResponse;
        setDirty(new Set());
        setMessage({ kind: 'ok', text: r.changed.length > 0 ? t('saved') : t('nothing_changed') });
        router.refresh();
        return;
      }
      const err = (await res.json().catch(() => ({ error: 'server_error' }))) as PaymentSettingsApiErrorBody;
      if (err.fields?.length) setInvalid(new Set(err.fields));
      const text =
        err.error === 'invalid_code' ? t('error_code')
        : err.error === 'step_up_required' ? t('error_step_up')
        : err.error === 'rate_limited' ? t('error_rate_limited')
        : err.error === 'invalid_input' ? t('error_fields')
        : err.error === 'unauthorized' ? t('error_session')
        : t('error_generic');
      setMessage({ kind: 'error', text });
      if (err.error === 'invalid_code' || err.error === 'step_up_required') document.getElementById(`${id}-code`)?.focus();
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="admin-form admin-settings-form" noValidate data-testid="payment-links-form">
      {METHODS.map((m) => {
        const s = settings[m];
        const state = s.value === null ? 'unset' : s.shownToCustomers ? 'shown' : 'refused';
        const hintId = `${id}-${m}-hint`;
        return (
          <div key={m} className="admin-field">
            <label htmlFor={`${id}-${m}`}>{t(`field.${m}`)}</label>
            <input
              id={`${id}-${m}`}
              dir="ltr"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={values[m]}
              onChange={(e) => {
                const v = e.target.value;
                setValues((x) => ({ ...x, [m]: v }));
                setDirty((d) => new Set(d).add(m));
              }}
              aria-invalid={invalid.has(m) || undefined}
              aria-describedby={hintId}
              data-testid={`payment-${m}`}
            />
            {invalid.has(m) ? <p className="admin-field-error">{t(`error_link.${m}`)}</p> : null}
            <p id={hintId} className="admin-hint" data-testid={`payment-${m}-state`} data-state={state}>
              {t(`state.${state}`)}
              {updatedAt[m] ? ` ${t('last_changed', { when: updatedAt[m] })}` : null}
            </p>
          </div>
        );
      })}
      <p className="admin-hint">{t('hosts_hint')}</p>

      <div className="admin-step-up">
        <div className="admin-field">
          <label htmlFor={`${id}-code`}>{t('code_label')}</label>
          <input
            id={`${id}-code`}
            className="admin-code-input"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            aria-invalid={invalid.has('code') || undefined}
            aria-describedby={`${id}-code-hint`}
            data-testid="payment-code"
          />
          <p id={`${id}-code-hint`} className="admin-hint">
            {t('code_hint')}
          </p>
        </div>
      </div>

      <button type="submit" className="btn btn-primary admin-submit" disabled={busy}>
        {t('save')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="payment-message" hidden={!message}>
        {message?.text}
      </p>
    </form>
  );
}
