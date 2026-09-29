'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/admin/capacity/Switch';
import type { MaterializeResult, PatternDay } from '@/lib/shared/contracts/capacity-pattern';

type Row = { weekday: number; isWorkingDay: boolean; oven: string; work: string };

const parseMinutes = (v: string): number | null => (/^\d{1,4}$/.test(v.trim()) && Number(v) <= 1440 ? Number(v) : null);

// The standing weekly pattern (PRD section 4): which weekdays are working days
// and their default oven and work minutes. Saving writes the pattern into the
// next days (PUT /api/admin/capacity/pattern); days set by hand stay as they are.
export function WeeklyPatternForm({ pattern }: { pattern: PatternDay[] }) {
  const t = useTranslations('admin.capacity');
  const router = useRouter();
  const id = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
      const p = pattern.find((d) => d.weekday === weekday);
      return { weekday, isWorkingDay: p?.isWorkingDay ?? false, oven: String(p?.ovenMinutesTotal ?? 0), work: String(p?.workMinutesTotal ?? 0) };
    }),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const update = (weekday: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.weekday === weekday ? { ...r, ...patch } : r)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const days = rows.map((r) => ({ weekday: r.weekday, isWorkingDay: r.isWorkingDay, ovenMinutesTotal: parseMinutes(r.oven), workMinutesTotal: parseMinutes(r.work) }));
    if (days.some((d) => d.ovenMinutesTotal === null || d.workMinutesTotal === null)) {
      setMessage({ kind: 'error', text: t('error_invalid_minutes') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/capacity/pattern', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days }) });
      if (res.ok) {
        const r = (await res.json()) as MaterializeResult;
        const parts = [t('pattern_saved', { written: r.written, days: r.days })];
        if (r.keptManual > 0) parts.push(t('pattern_kept_manual', { count: r.keptManual }));
        if (r.keptBelowReserved.length > 0) parts.push(t('pattern_kept_below', { count: r.keptBelowReserved.length }));
        setMessage({ kind: 'ok', text: parts.join(' ') });
        router.refresh();
      } else {
        setMessage({ kind: 'error', text: res.status === 401 ? t('error_session') : res.status === 400 ? t('error_invalid_minutes') : t('error_generic') });
      }
    } catch {
      setMessage({ kind: 'error', text: t('error_generic') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="admin-pattern" noValidate data-testid="weekly-pattern">
      {pattern.length === 0 ? <p className="admin-hint">{t('pattern_empty')}</p> : null}
      {rows.map((r) => (
        <fieldset key={r.weekday} className="admin-pattern-day" data-testid={`pattern-${r.weekday}`}>
          <legend id={`${id}-d${r.weekday}`} className="admin-pattern-name">
            {t(`weekday.${r.weekday}`)}
          </legend>
          <div className="admin-toggle-row">
            <span id={`${id}-w${r.weekday}`}>{t('working_day')}</span>
            <Switch
              checked={r.isWorkingDay}
              onChange={(v) => update(r.weekday, { isWorkingDay: v })}
              labelledBy={`${id}-d${r.weekday} ${id}-w${r.weekday}`}
              testId={`pattern-${r.weekday}-working`}
            />
          </div>
          {r.isWorkingDay ? (
            <div className="admin-edit-row">
              <div className="admin-field">
                <label htmlFor={`${id}-o${r.weekday}`}>{t('oven_minutes')}</label>
                <input id={`${id}-o${r.weekday}`} inputMode="numeric" className="num" dir="ltr" maxLength={4} value={r.oven} onChange={(e) => update(r.weekday, { oven: e.target.value })} data-testid={`pattern-${r.weekday}-oven`} />
              </div>
              <div className="admin-field">
                <label htmlFor={`${id}-k${r.weekday}`}>{t('work_minutes')}</label>
                <input id={`${id}-k${r.weekday}`} inputMode="numeric" className="num" dir="ltr" maxLength={4} value={r.work} onChange={(e) => update(r.weekday, { work: e.target.value })} data-testid={`pattern-${r.weekday}-work`} />
              </div>
            </div>
          ) : null}
        </fieldset>
      ))}
      <p className="admin-hint">{t('pattern_explain')}</p>
      <button type="submit" className="btn btn-primary admin-submit" disabled={busy}>
        {t('save_pattern')}
      </button>
      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="pattern-message" hidden={!message}>
        {message?.text}
      </p>
    </form>
  );
}
