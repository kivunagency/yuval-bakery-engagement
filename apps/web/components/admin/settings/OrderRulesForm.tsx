'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ORDER_RULES, ORDER_RULE_NAMES, invalidOrderRuleFields, type OrderRule, type OrderSettings, type OrderSettingsApiErrorBody } from '@/lib/shared/contracts/order-settings';

// Order rules (settings-slots): how long an unpaid order holds its time
// (PRD US-9, Yuval's to set) and when a day shows as "limited". A value that
// is still the PRD default says so until Yuval saves it.
export function OrderRulesForm({ rules }: { rules: OrderSettings['rules'] }) {
  const t = useTranslations('admin.settings.hours');
  const router = useRouter();
  const id = useId();
  const [values, setValues] = useState<Record<OrderRule, string>>(
    () => Object.fromEntries(ORDER_RULE_NAMES.map((r) => [r, rules[r].value === null ? '' : String(rules[r].value)])) as Record<OrderRule, string>,
  );
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // Every rule is sent: saving confirms a default too (the DB records it).
    const body = Object.fromEntries(ORDER_RULE_NAMES.map((r) => [r, /^\d{1,3}$/.test(values[r].trim()) ? Number(values[r].trim()) : values[r]]));
    const bad = invalidOrderRuleFields(body);
    setInvalid(new Set(bad));
    if (bad.length > 0) {
      setMessage({ kind: 'error', text: t('error_rules') });
      document.getElementById(`${id}-${bad[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/settings/order-rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        setMessage({ kind: 'ok', text: t('rules_saved') });
        router.refresh();
        return;
      }
      const err = (await res.json().catch(() => ({ error: 'server_error' }))) as OrderSettingsApiErrorBody;
      if (err.fields?.length) setInvalid(new Set(err.fields));
      setMessage({ kind: 'error', text: err.error === 'invalid_input' ? t('error_rules') : err.error === 'unauthorized' ? t('error_session') : t('error_generic') });
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="admin-form admin-settings-form" noValidate data-testid="order-rules-form">
      {ORDER_RULE_NAMES.map((r) => (
        <div key={r} className="admin-field">
          <label htmlFor={`${id}-${r}`}>{t(`rule.${r}`)}</label>
          <div className="admin-unit-row">
            <input
              id={`${id}-${r}`}
              className="num"
              dir="ltr"
              inputMode="numeric"
              maxLength={3}
              value={values[r]}
              onChange={(e) => setValues((v) => ({ ...v, [r]: e.target.value }))}
              aria-invalid={invalid.has(r) || undefined}
              aria-describedby={`${id}-${r}-hint`}
              data-testid={`rule-${r}`}
            />
            <span className="admin-unit">{t(`unit.${r}`)}</span>
          </div>
          {invalid.has(r) ? <p className="admin-field-error">{t('error_range', { min: ORDER_RULES[r].min, max: ORDER_RULES[r].max })}</p> : null}
          <p id={`${id}-${r}-hint`} className="admin-hint">
            {t(`rule_hint.${r}`, { min: ORDER_RULES[r].min, max: ORDER_RULES[r].max })}
          </p>
          {!rules[r].confirmed ? (
            <p className="admin-hint admin-default-note" data-testid={`rule-${r}-default`}>
              {t('default_note')}
            </p>
          ) : null}
        </div>
      ))}
      <button type="submit" className="btn btn-primary admin-submit" disabled={busy}>
        {t('save_rules')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="rules-message" hidden={!message}>
        {message?.text}
      </p>
    </form>
  );
}
