'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SLOTS_MAX, slotProblems, type AdminSlot, type OrderSettingsApiErrorBody } from '@/lib/shared/contracts/order-settings';

type Row = { key: number; start: string; end: string };

// Delivery/pickup time slots (settings-slots). The whole list is saved at
// once (PUT /api/admin/settings/time-slots); a slot removed here is turned
// off in the DB, never deleted, and orders keep their own copy of it.
export function TimeSlotsForm({ slots }: { slots: AdminSlot[] }) {
  const t = useTranslations('admin.settings.hours');
  const router = useRouter();
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() => slots.map((s, i) => ({ key: i, start: s.start, end: s.end })));
  const [nextKey, setNextKey] = useState(slots.length);
  const [invalid, setInvalid] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const list = rows.map((r) => ({ start: r.start.trim(), end: r.end.trim() }));
    const p = slotProblems(list);
    setInvalid(new Set(p.invalid.map((i) => rows[i]!.key)));
    if (p.count || p.invalid.length > 0 || p.overlap) {
      setMessage({ kind: 'error', text: p.count ? t('error_count', { max: SLOTS_MAX }) : p.invalid.length > 0 ? t('error_slot') : t('error_overlap') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/settings/time-slots', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slots: list }) });
      if (res.ok) {
        const saved = (await res.json()) as { slots: AdminSlot[] };
        setRows(saved.slots.map((s, i) => ({ key: nextKey + i, start: s.start, end: s.end })));
        setNextKey((k) => k + saved.slots.length);
        setMessage({ kind: 'ok', text: t('slots_saved') });
        router.refresh();
        return;
      }
      const err = (await res.json().catch(() => ({ error: 'server_error' }))) as OrderSettingsApiErrorBody;
      setMessage({ kind: 'error', text: err.error === 'overlap' ? t('error_overlap') : err.error === 'invalid_input' ? t('error_slot') : err.error === 'unauthorized' ? t('error_session') : t('error_generic') });
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="admin-form admin-settings-form" noValidate data-testid="time-slots-form">
      {rows.length === 0 ? <p className="admin-note" data-testid="slots-empty">{t('slots_empty')}</p> : null}
      <ul className="admin-slots">
        {rows.map((r, i) => (
          <li key={r.key} className="admin-slot" data-testid={`slot-${i}`} data-invalid={invalid.has(r.key) || undefined}>
            <div className="admin-field">
              <label htmlFor={`${id}-s${r.key}`}>{t('slot_start')}</label>
              <input id={`${id}-s${r.key}`} dir="ltr" inputMode="numeric" maxLength={5} placeholder="10:00" value={r.start} aria-invalid={invalid.has(r.key) || undefined} onChange={(e) => update(r.key, { start: e.target.value })} data-testid={`slot-${i}-start`} />
            </div>
            <div className="admin-field">
              <label htmlFor={`${id}-e${r.key}`}>{t('slot_end')}</label>
              <input id={`${id}-e${r.key}`} dir="ltr" inputMode="numeric" maxLength={5} placeholder="12:00" value={r.end} aria-invalid={invalid.has(r.key) || undefined} onChange={(e) => update(r.key, { end: e.target.value })} data-testid={`slot-${i}-end`} />
            </div>
            <button
              type="button"
              className="admin-slot-remove"
              aria-label={t('remove_slot', { start: r.start || '?', end: r.end || '?' })}
              onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              data-testid={`slot-${i}-remove`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {rows.length < SLOTS_MAX ? (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setRows((rs) => [...rs, { key: nextKey, start: '', end: '' }]);
            setNextKey((k) => k + 1);
          }}
          data-testid="slot-add"
        >
          {t('add_slot')}
        </button>
      ) : null}
      <p className="admin-hint">{t('slots_hint')}</p>
      <button type="submit" className="btn btn-primary admin-submit" disabled={busy}>
        {t('save_slots')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="slots-message" hidden={!message}>
        {message?.text}
      </p>
    </form>
  );
}
