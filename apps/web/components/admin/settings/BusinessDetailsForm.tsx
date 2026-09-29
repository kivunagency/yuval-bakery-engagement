'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { displayPhone } from '@/lib/shared/contact/links';
import {
  BUSINESS_FIELDS,
  invalidBusinessFields,
  type BusinessField,
  type BusinessSettings,
  type BusinessSettingsApiErrorBody,
  type VatStatus,
} from '@/lib/shared/contracts/business-settings';

// The s.14C business details and the osek status (settings-business). Each
// field is what the site shows; an empty field shows the site's placeholder
// (for example [שם העסק]) until Yuval fills it in. Only changed fields are
// sent (PUT /api/admin/settings/business); the DB validates again and audits.

const LTR: ReadonlySet<BusinessField> = new Set(['registrationNumber', 'phone', 'whatsapp', 'email']);
const INPUT_MODE: Partial<Record<BusinessField, 'numeric' | 'tel' | 'email'>> = { registrationNumber: 'numeric', phone: 'tel', whatsapp: 'tel', email: 'email' };
const AUTOCOMPLETE: Partial<Record<BusinessField, string>> = { name: 'organization', ownerName: 'name', address: 'street-address', phone: 'tel', whatsapp: 'tel', email: 'email' };
/** The key of the site's placeholder for an unset field (business.details.*). */
const PLACEHOLDER_KEY: Record<BusinessField, string> = {
  name: 'name',
  ownerName: 'owner_name',
  registrationNumber: 'registration_number',
  address: 'address',
  phone: 'phone',
  whatsapp: 'phone',
  email: 'email',
};

function initialValue(field: BusinessField, settings: BusinessSettings): string {
  const v = settings[field];
  if (!v) return '';
  return field === 'phone' || field === 'whatsapp' ? (displayPhone(v) ?? v) : v;
}

export function BusinessDetailsForm({ settings }: { settings: BusinessSettings }) {
  const t = useTranslations('admin.settings.business');
  const tPlaceholder = useTranslations('business.details');
  const router = useRouter();
  const id = useId();
  const [values, setValues] = useState<Record<BusinessField, string>>(
    () => Object.fromEntries(BUSINESS_FIELDS.map((f) => [f, initialValue(f, settings)])) as Record<BusinessField, string>,
  );
  const [dirty, setDirty] = useState<Set<BusinessField>>(new Set());
  // Unconfirmed default: nothing is pre-selected, so saving never confirms it by accident.
  const [vat, setVat] = useState<VatStatus | null>(settings.vatStatusConfirmed ? settings.vatStatus : null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const change = (field: BusinessField, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setDirty((d) => new Set(d).add(field));
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, string | null> = {};
    for (const f of dirty) body[f] = values[f].trim() === '' ? null : values[f];
    if (vat && (!settings.vatStatusConfirmed || vat !== settings.vatStatus)) body.vatStatus = vat;
    if (Object.keys(body).length === 0) {
      setMessage({ kind: 'ok', text: t('nothing_changed') });
      return;
    }
    const bad = invalidBusinessFields(body);
    setInvalid(new Set(bad));
    if (bad.length > 0) {
      setMessage({ kind: 'error', text: t('error_fields') });
      document.getElementById(`${id}-${bad[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/settings/business', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        setDirty(new Set());
        setMessage({ kind: 'ok', text: t('saved') });
        router.refresh();
        return;
      }
      const err = (await res.json().catch(() => ({ error: 'server_error' }))) as BusinessSettingsApiErrorBody;
      if (err.fields?.length) setInvalid(new Set(err.fields));
      setMessage({ kind: 'error', text: res.status === 401 ? t('error_session') : res.status === 400 ? t('error_fields') : t('error_generic') });
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="admin-form admin-settings-form" noValidate data-testid="business-details-form">
      {BUSINESS_FIELDS.map((f) => {
        const hintId = `${id}-${f}-hint`;
        const errorId = `${id}-${f}-error`;
        const isInvalid = invalid.has(f);
        return (
          <div key={f} className="admin-field">
            <label htmlFor={`${id}-${f}`}>{t(`field.${f}`)}</label>
            <input
              id={`${id}-${f}`}
              name={f}
              dir={LTR.has(f) ? 'ltr' : undefined}
              inputMode={INPUT_MODE[f]}
              autoComplete={AUTOCOMPLETE[f] ?? 'off'}
              value={values[f]}
              onChange={(e) => change(f, e.target.value)}
              aria-invalid={isInvalid || undefined}
              aria-describedby={isInvalid ? `${errorId} ${hintId}` : hintId}
              data-testid={`business-${f}`}
            />
            {isInvalid ? (
              <p id={errorId} className="admin-field-error">
                {t(`error.${f}`)}
              </p>
            ) : null}
            <p id={hintId} className="admin-hint">
              {t(`hint.${f}`)}{' '}
              {values[f].trim() === '' ? t('empty_shows', { placeholder: tPlaceholder(PLACEHOLDER_KEY[f]) }) : null}
            </p>
          </div>
        );
      })}

      <fieldset className="admin-radio-group" aria-describedby={`${id}-vat-hint`} data-testid="business-vatStatus">
        <legend>{t('field.vatStatus')}</legend>
        {(['exempt', 'licensed'] as const).map((s) => (
          <label key={s} className="admin-radio">
            <input type="radio" name="vatStatus" value={s} checked={vat === s} onChange={() => setVat(s)} data-testid={`business-vat-${s}`} />
            <span>{t(`vat.${s}`)}</span>
          </label>
        ))}
        <p id={`${id}-vat-hint`} className="admin-hint">
          {t('hint.vatStatus')}
        </p>
        {!settings.vatStatusConfirmed ? (
          <p className="admin-note" data-testid="business-vat-unconfirmed">
            {t('vat_unconfirmed', { current: t(`vat.${settings.vatStatus ?? 'exempt'}`) })}
          </p>
        ) : null}
      </fieldset>

      <button type="submit" className="btn btn-primary admin-submit" disabled={busy}>
        {t('save')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="business-message" hidden={!message}>
        {message?.text}
      </p>
    </form>
  );
}
