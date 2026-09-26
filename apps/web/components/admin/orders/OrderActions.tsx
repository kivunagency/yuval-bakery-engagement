'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatIls } from '@/lib/shared/price/vat';
import type { AdminOrderAction, AdminOrdersApiErrorBody } from '@/lib/shared/contracts/admin-orders';
import type { OrderStatus } from '@/lib/shared/types';

type Step = 'idle' | 'confirm-paid' | 'confirm-cancel';
const DONE: Record<AdminOrderAction, string> = { 'mark-paid': 'paid', cancel: 'cancelled', 'mark-fulfilled': 'fulfilled' };

// The actions of one order (client-009). Whether a transition is allowed is
// the DB's answer (api-004 routes); this only shows the buttons that make
// sense for the status the page was rendered with, and asks before the two
// that cannot be undone. "Mark as paid" shows the expected amount large
// (SEC-008), so Yuval compares it with what arrived in Bit or PayBox.
export function OrderActions({
  id,
  orderNumber,
  status,
  total,
  dayLabel,
  confirmationMissing,
  listQuery,
}: {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  total: number;
  dayLabel: string;
  confirmationMissing: boolean;
  /** The list's own query (status, day), kept when the page reloads after an action. */
  listQuery: string;
}) {
  const t = useTranslations('admin.orders');
  const router = useRouter();
  const [step, setStep] = useState<Step>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ltr = (chunks: React.ReactNode) => <span className="ltr num">{chunks}</span>;

  if (status !== 'payment_pending' && status !== 'paid') return null;

  async function run(action: AdminOrderAction) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/orders/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (res.ok) {
        const q = new URLSearchParams(listQuery);
        q.set('done', DONE[action]);
        q.set('order', orderNumber);
        router.replace(`/admin/orders?${q.toString()}`, { scroll: false });
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as AdminOrdersApiErrorBody | null;
      if (body?.error === 'invalid_transition' && body.status) {
        setError(t('error_transition', { status: t(`status.${body.status}`) }));
        router.refresh();
      } else if (body?.error === 'confirmation_required') setError(t('error_confirmation'));
      else if (body?.error === 'unauthorized') setError(t('error_session'));
      else if (body?.error === 'not_found') setError(t('error_not_found'));
      else setError(t('error_generic'));
    } catch {
      setError(t('error_generic'));
    } finally {
      setBusy(false);
      setStep('idle');
    }
  }

  return (
    <div className="admin-order-actions">
      {step === 'confirm-paid' ? (
        <div className="admin-confirm" role="group" aria-labelledby={`paid-${id}`} data-testid="confirm-paid">
          <p id={`paid-${id}`} className="admin-confirm-title">
            {t('mark_paid_title')}
          </p>
          <p className="admin-expected">
            <span>{t('expected_amount')}</span>
            <span className="admin-expected-amount num" data-testid="expected-amount">
              {formatIls(total)}
            </span>
          </p>
          <p className="admin-hint">{t.rich('mark_paid_check', { number: orderNumber, ltr })}</p>
          <div className="admin-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('mark-paid')} data-testid="confirm-paid-yes">
              {t('confirm_paid')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setStep('idle')}>
              {t('back')}
            </button>
          </div>
        </div>
      ) : step === 'confirm-cancel' ? (
        <div className="admin-confirm" role="group" aria-labelledby={`cancel-${id}`} data-testid="confirm-cancel">
          <p id={`cancel-${id}`} className="admin-confirm-title">
            {t('cancel_title')}
          </p>
          <p className="admin-hint">{t('cancel_explain', { date: dayLabel })}</p>
          {status === 'paid' ? <p className="admin-warn">{t('cancel_paid_note')}</p> : null}
          <div className="admin-actions">
            <button type="button" className="btn admin-btn-danger" disabled={busy} onClick={() => run('cancel')} data-testid="confirm-cancel-yes">
              {t('confirm_cancel')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setStep('idle')}>
              {t('back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-actions">
          {status === 'payment_pending' ? (
            <button type="button" className="btn btn-primary" onClick={() => setStep('confirm-paid')} data-testid="mark-paid">
              {t('mark_paid')}
            </button>
          ) : confirmationMissing ? (
            <div className="admin-warn" data-testid="fulfil-blocked">
              <p>{t('fulfil_blocked')}</p>
              <p>{t('fulfil_blocked_next')}</p>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('mark-fulfilled')} data-testid="mark-fulfilled">
              {t('mark_fulfilled')}
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => setStep('confirm-cancel')} data-testid="cancel">
            {t('cancel')}
          </button>
        </div>
      )}
      <p className="admin-form-error" role="alert" data-testid="order-error" hidden={!error}>
        {error}
      </p>
    </div>
  );
}
