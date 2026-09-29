'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { displayPhone, telHref } from '@/lib/shared/contact/links';
import type {
  CustomCakeAdminErrorBody,
  CustomCakeApproveResponse,
  CustomCakeCapacityCheck,
  CustomCakeDeclineResponse,
  QueueItem,
} from '@/lib/shared/contracts/custom-cake';

// One pending custom-cake request (client-008). Everything the customer typed
// is rendered as React text (escaped, SEC-025), never as HTML. Yuval sets the
// price and the oven/work minutes; while she types, the screen asks the DB
// whether that fits the day (GET .../capacity) and shows the answer as it
// comes, never computing it here. Approve and decline go to api-006. After
// either, a WhatsApp click-to-send link (US-11); nothing is sent automatically.

type Check = { state: 'idle' | 'loading' | 'error' } | { state: 'ready'; value: CustomCakeCapacityCheck };
type Done = { kind: 'approved'; value: CustomCakeApproveResponse } | { kind: 'declined'; value: CustomCakeDeclineResponse } | null;

/** Whole minutes 0..1440, or null. Form help only; the server and the DB decide. */
function parseMinutes(v: string): number | null {
  if (!/^\d{1,4}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n <= 1440 ? n : null;
}
/** Shekels, up to 2 decimals, above 0, or null. */
function parsePrice(v: string): number | null {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n > 0 && n <= 100_000 ? n : null;
}

export function CustomCakeRequestCard({ item }: { item: QueueItem }) {
  const t = useTranslations('admin.custom_cake');
  const tw = useTranslations('admin.capacity.weekday');
  const id = useId();
  const [price, setPrice] = useState('');
  const [oven, setOven] = useState('');
  const [work, setWork] = useState('');
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<Done>(null);

  const ovenMin = parseMinutes(oven);
  const workMin = parseMinutes(work);
  const priceValue = parsePrice(price);

  // Live capacity answer, debounced; the last answer wins.
  useEffect(() => {
    if (ovenMin === null || workMin === null) {
      setCheck({ state: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    setCheck({ state: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/custom-cake-requests/${item.id}/capacity?oven=${ovenMin}&work=${workMin}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error('check');
        setCheck({ state: 'ready', value: (await res.json()) as CustomCakeCapacityCheck });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setCheck({ state: 'error' });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [item.id, ovenMin, workMin]);

  const weekday = new Date(`${item.desiredDate}T12:00:00Z`).getUTCDay();
  const [, month, dom] = item.desiredDate.split('-').map(Number) as [number, number, number];
  const dateLabel = t('date_label', { weekday: tw(String(weekday)), date: `${dom}.${month}` });
  const tel = telHref(item.phone);
  const shownPhone = displayPhone(item.phone) ?? item.phone;

  async function errorText(res: Response): Promise<string> {
    const body = (await res.json().catch(() => null)) as CustomCakeAdminErrorBody | null;
    if (body?.error === 'capacity_changed') {
      if (body.check) setCheck({ state: 'ready', value: body.check });
      return t('error_capacity_changed');
    }
    if (body?.error === 'not_pending') return t('error_not_pending');
    if (body?.error === 'unauthorized') return t('error_session');
    if (body?.error === 'invalid_input') return t('error_invalid');
    return t('error_generic');
  }

  async function approve(e: React.FormEvent) {
    e.preventDefault();
    if (priceValue === null || ovenMin === null || workMin === null) {
      setError(t('error_invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/custom-cake-requests/${item.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ price: priceValue, ovenMinutes: ovenMin, workMinutes: workMin }),
      });
      if (res.ok) setDone({ kind: 'approved', value: (await res.json()) as CustomCakeApproveResponse });
      else setError(await errorText(res));
    } catch {
      setError(t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/custom-cake-requests/${item.id}/decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) setDone({ kind: 'declined', value: (await res.json()) as CustomCakeDeclineResponse });
      else setError(await errorText(res));
    } catch {
      setError(t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  const headingId = `${id}-h`;
  return (
    <article className="admin-cc" aria-labelledby={headingId} data-testid="custom-cake-card">
      <header className="admin-cc-head">
        <h2 id={headingId}>{dateLabel}</h2>
        <p className="admin-cc-who">
          <span>{item.name ?? t('no_name')}</span>
          {tel ? (
            <a href={tel} className="admin-inline-link">
              <span className="ltr num">{shownPhone}</span>
            </a>
          ) : (
            <span className="ltr num">{shownPhone}</span>
          )}
        </p>
        {item.email ? <p className="admin-cc-meta"><span className="ltr">{item.email}</span></p> : null}
        <p className="admin-cc-meta">{item.whatsappOk ? t('whatsapp_ok_yes') : t('whatsapp_ok_no')}</p>
      </header>

      <dl className="admin-cc-text">
        <dt>{t('inscription')}</dt>
        <dd>{item.inscription ? <bdi>{item.inscription}</bdi> : <span className="admin-cc-none">{t('none')}</span>}</dd>
        <dt>{t('notes')}</dt>
        <dd>{item.notes ? <bdi>{item.notes}</bdi> : <span className="admin-cc-none">{t('none')}</span>}</dd>
      </dl>

      <section aria-label={t('photos')} className="admin-cc-photos">
        {item.photos.length === 0 ? (
          <p className="admin-cc-meta">{t('no_photos')}</p>
        ) : (
          <ul>
            {item.photos.map((p, i) =>
              p.url ? (
                <li key={p.path}>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="admin-cc-photo">
                    {/* Signed URL to the private bucket, minted on the server for this admin, valid for minutes. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt={t('photo_alt', { n: i + 1 })} width={160} height={160} loading="lazy" />
                  </a>
                </li>
              ) : (
                <li key={p.path} className="admin-cc-meta">
                  {t('photo_unavailable', { n: i + 1 })}
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      {done?.kind === 'approved' ? (
        <div className="admin-cc-done" role="status">
          <p className="admin-ok">{t('approved_done', { total: done.value.total })}</p>
          <p>
            {t('order_number')} <span className="ltr num admin-cc-order">{done.value.orderNumber}</span>
          </p>
          <p className="admin-hint">{t('payment_link_label')}</p>
          <p className="admin-cc-link ltr" data-testid="payment-link">{done.value.paymentPageUrl}</p>
          {done.value.whatsappHref ? (
            <a className="btn btn-primary admin-cc-wa" href={done.value.whatsappHref} target="_blank" rel="noopener noreferrer">
              {t('send_whatsapp')}
            </a>
          ) : (
            <p className="admin-warn">{t('no_whatsapp')}</p>
          )}
        </div>
      ) : done?.kind === 'declined' ? (
        <div className="admin-cc-done" role="status">
          <p className="admin-ok">{t('declined_done')}</p>
          {done.value.whatsappHref ? (
            <a className="btn btn-secondary admin-cc-wa" href={done.value.whatsappHref} target="_blank" rel="noopener noreferrer">
              {t('send_whatsapp')}
            </a>
          ) : (
            <p className="admin-warn">{t('no_whatsapp')}</p>
          )}
        </div>
      ) : (
        <form className="admin-form" onSubmit={approve} noValidate>
          <div className="admin-field">
            <label htmlFor={`${id}-price`}>{t('set_price')}</label>
            <input id={`${id}-price`} inputMode="decimal" className="num" dir="ltr" maxLength={9} value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <fieldset className="admin-cc-time">
            <legend>{t('set_time_cost')}</legend>
            <div className="admin-edit-row">
              <div className="admin-field">
                <label htmlFor={`${id}-oven`}>{t('oven_minutes')}</label>
                <input id={`${id}-oven`} inputMode="numeric" className="num" dir="ltr" maxLength={4} value={oven} onChange={(e) => setOven(e.target.value)} />
              </div>
              <div className="admin-field">
                <label htmlFor={`${id}-work`}>{t('work_minutes')}</label>
                <input id={`${id}-work`} inputMode="numeric" className="num" dir="ltr" maxLength={4} value={work} onChange={(e) => setWork(e.target.value)} />
              </div>
            </div>
          </fieldset>
          <div aria-live="polite" data-testid="capacity-answer">
            <CapacityAnswer check={check} />
          </div>
          {error ? (
            <p className="admin-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="admin-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || (check.state === 'ready' && !check.value.fits)}>
              {t('approve')}
            </button>
            {!declineOpen ? (
              <button type="button" className="btn btn-secondary" onClick={() => setDeclineOpen(true)} disabled={busy}>
                {t('decline')}
              </button>
            ) : null}
          </div>
          {declineOpen ? (
            <div className="admin-cc-decline">
              <div className="admin-field">
                <label htmlFor={`${id}-reason`}>{t('decline_reason')}</label>
                <textarea id={`${id}-reason`} rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${id}-reason-hint`} />
                <p id={`${id}-reason-hint`} className="admin-hint">
                  {t('decline_reason_hint')}
                </p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={decline} disabled={busy}>
                {t('decline_confirm')}
              </button>
            </div>
          ) : null}
        </form>
      )}
    </article>
  );
}

function CapacityAnswer({ check }: { check: Check }) {
  const t = useTranslations('admin.custom_cake');
  if (check.state === 'idle') return <p className="admin-hint">{t('capacity_idle')}</p>;
  if (check.state === 'loading') return <p className="admin-hint">{t('capacity_loading')}</p>;
  if (check.state !== 'ready') return <p className="admin-warn">{t('capacity_error')}</p>;
  const c = check.value;
  if (c.dayPassed) return <p className="admin-warn">{t('capacity_day_passed')}</p>;
  if (!c.hasDay) return <p className="admin-warn">{t('capacity_no_day')}</p>;
  if (c.isBlackout) return <p className="admin-warn">{t('capacity_blackout')}</p>;
  if (c.fits) return <p className="admin-ok">{t('capacity_fits', { oven: c.ovenMinutesLeft ?? 0, work: c.workMinutesLeft ?? 0 })}</p>;
  return (
    <div className="admin-warn">
      <p>{t('capacity_warning', { oven: c.ovenMinutesLeft ?? 0, work: c.workMinutesLeft ?? 0 })}</p>
      {c.ovenMinutesUnpaidLeft !== null && c.workMinutesUnpaidLeft !== null ? (
        <p>{t('capacity_warning_unpaid', { oven: c.ovenMinutesUnpaidLeft, work: c.workMinutesUnpaidLeft })}</p>
      ) : null}
    </div>
  );
}
