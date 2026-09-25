'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/admin/capacity/Switch';
import type { CapacityApiErrorBody } from '@/lib/shared/contracts/capacity';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** Parses a minutes field: whole number 0..1440, or null. Form validation only; the server and the DB decide. */
function parseMinutes(v: string): number | null {
  if (!/^\d{1,4}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n <= 1440 ? n : null;
}

// Edits one day: oven and work minutes, and the "closed day" switch. Saves
// through PATCH /api/admin/capacity/[date]; whether a total fits the orders
// already booked is decided by the DB (409 below_reserved), not here.
export function CapacityDayForm({
  day,
  initial,
  orderCount,
  source,
  canReset,
}: {
  day: string;
  initial: { ovenMinutesTotal: number; workMinutesTotal: number; isBlackout: boolean };
  orderCount: number;
  source: 'manual' | 'pattern' | 'none';
  canReset: boolean;
}) {
  const t = useTranslations('admin.capacity');
  const router = useRouter();
  const id = useId();
  const [oven, setOven] = useState(String(initial.ovenMinutesTotal));
  const [work, setWork] = useState(String(initial.workMinutesTotal));
  const [blackout, setBlackout] = useState(initial.isBlackout);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  // After router.refresh() (this form's save, a reset, or a weekly-pattern
  // save) the server sends the day's current numbers: show them, and keep the
  // message the user just got.
  useEffect(() => {
    setOven(String(initial.ovenMinutesTotal));
    setWork(String(initial.workMinutesTotal));
    setBlackout(initial.isBlackout);
  }, [initial.ovenMinutesTotal, initial.workMinutesTotal, initial.isBlackout]);

  const errorText = async (res: Response): Promise<string> => {
    const body = (await res.json().catch(() => null)) as CapacityApiErrorBody | null;
    if (body?.error === 'below_reserved' && body.reserved) return t('error_below_reserved', { oven: body.reserved.ovenMinutes, work: body.reserved.workMinutes });
    if (body?.error === 'invalid_input') return t('error_invalid_minutes');
    if (body?.error === 'unauthorized') return t('error_session');
    if (body?.error === 'no_pattern_for_weekday') return t('error_no_pattern');
    return t('error_generic');
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ovenMinutesTotal = parseMinutes(oven);
    const workMinutesTotal = parseMinutes(work);
    if (ovenMinutesTotal === null || workMinutesTotal === null) {
      setMessage({ kind: 'error', text: t('error_invalid_minutes') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/capacity/${day}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ovenMinutesTotal, workMinutesTotal, isBlackout: blackout }),
      });
      setMessage(res.ok ? { kind: 'ok', text: t('saved') } : { kind: 'error', text: await errorText(res) });
      if (res.ok) router.refresh();
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/capacity/${day}/reset`, { method: 'POST' });
      if (res.ok) {
        const row = (await res.json()) as { ovenMinutesTotal: number; workMinutesTotal: number; isBlackout: boolean };
        setOven(String(row.ovenMinutesTotal));
        setWork(String(row.workMinutesTotal));
        setBlackout(row.isBlackout);
        setMessage({ kind: 'ok', text: t('reset_done') });
        router.refresh();
      } else {
        setMessage({ kind: 'error', text: await errorText(res) });
      }
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="admin-capacity-form" noValidate>
      <div className="admin-edit-row">
        <div className="admin-field">
          <label htmlFor={`${id}-oven`}>{t('oven_minutes')}</label>
          <input id={`${id}-oven`} inputMode="numeric" className="num" value={oven} onChange={(e) => setOven(e.target.value)} maxLength={4} dir="ltr" data-testid="day-oven" />
        </div>
        <div className="admin-field">
          <label htmlFor={`${id}-work`}>{t('work_minutes')}</label>
          <input id={`${id}-work`} inputMode="numeric" className="num" value={work} onChange={(e) => setWork(e.target.value)} maxLength={4} dir="ltr" data-testid="day-work" />
        </div>
      </div>
      <div className="admin-toggle-row">
        <span id={`${id}-blackout`}>{t('blackout_toggle')}</span>
        <Switch checked={blackout} onChange={setBlackout} labelledBy={`${id}-blackout`} testId="day-blackout" />
      </div>
      {blackout && orderCount > 0 ? (
        <p className="admin-warn" data-testid="blackout-warning">
          {t('blackout_has_orders', { count: orderCount })}
        </p>
      ) : null}
      <p className="admin-hint" data-testid="day-source">
        {t(`source_${source}`)}
      </p>
      <div className="admin-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('save_day')}
        </button>
        {canReset ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={reset}>
            {t('reset_to_pattern')}
          </button>
        ) : null}
      </div>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="day-message" hidden={!message}>
        {message?.text}
      </p>
    </form>
  );
}
