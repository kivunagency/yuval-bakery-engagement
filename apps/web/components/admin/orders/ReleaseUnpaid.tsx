'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { AdminOrdersApiErrorBody, ReleaseUnpaidResult } from '@/lib/shared/contracts/admin-orders';

// SEC-006 response tool (client-009): release every order of one day that is
// still waiting for payment. The DB cancels each one through
// fn_release_order_capacity (fn_admin_release_unpaid_for_day); paid orders are
// never touched. Asks first: it cannot be undone.
export function ReleaseUnpaid({ day, dayLabel, count }: { day: string; dayLabel: string; count: number }) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function release() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/orders/release-unpaid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ day }),
      });
      if (res.ok) {
        const body = (await res.json()) as ReleaseUnpaidResult;
        const q = new URLSearchParams({ status: 'payment_pending', day, done: 'released', count: String(body.released) });
        router.replace(`/admin/orders?${q.toString()}`, { scroll: false });
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as AdminOrdersApiErrorBody | null;
      setError(body?.error === 'unauthorized' ? t('error_session') : t('error_generic'));
    } catch {
      setError(t('error_generic'));
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  return (
    <div className="admin-release">
      {asking ? (
        <div className="admin-confirm" role="group" aria-labelledby={`release-${day}`} data-testid={`release-confirm-${day}`}>
          <p id={`release-${day}`} className="admin-confirm-title">
            {t('release_title', { day: dayLabel })}
          </p>
          <p className="admin-hint">{t('release_explain')}</p>
          <div className="admin-actions">
            <button type="button" className="btn admin-btn-danger" disabled={busy} onClick={release} data-testid={`release-yes-${day}`}>
              {t('release_confirm')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setAsking(false)}>
              {t('back')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary admin-release-button" onClick={() => setAsking(true)} data-testid={`release-${day}`}>
          {t('release_button', { count })}
        </button>
      )}
      <p className="admin-form-error" role="alert" hidden={!error}>
        {error}
      </p>
    </div>
  );
}
