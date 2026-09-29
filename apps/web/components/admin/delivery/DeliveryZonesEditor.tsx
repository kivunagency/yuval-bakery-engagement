'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/admin/capacity/Switch';
import {
  normalizeCity,
  zoneFee,
  type AdminDeliveryZone,
  type DeliveryZonesApiErrorBody,
} from '@/lib/shared/contracts/delivery-zones';

type Message = { kind: 'ok' | 'error'; text: string } | null;

/** Wraps a user-typed name (city, zone) in FSI..PDI so its direction never reorders the sentence around it. */
const iso = (s: string) => `\u2068${s}\u2069`;
type Translate = ReturnType<typeof useTranslations<'admin.delivery_zones'>>;

/** Whole shekels 0..1000, or null. Form validation only; the server and the DB decide. */
function parseFee(v: string): number | null {
  if (!/^\d{1,4}$/.test(v.trim())) return null;
  const r = zoneFee.safeParse(Number(v.trim()));
  return r.success ? r.data : null;
}

async function errorText(t: Translate, res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as DeliveryZonesApiErrorBody | null;
  switch (body?.error) {
    case 'city_in_other_zone':
      return body.zoneName ? t('error_city_in_other_zone', { city: iso(body.city ?? ''), zone: iso(body.zoneName) }) : t('error_city_taken', { city: iso(body.city ?? '') });
    case 'name_taken':
      return t('error_name_taken');
    case 'invalid_input':
      return t('error_invalid');
    case 'not_found':
      return t('error_not_found');
    case 'unauthorized':
      return t('error_session');
    default:
      return t('error_generic');
  }
}

/** One request to the zones API; returns the zone (or null for delete) or an error text. */
async function send(t: Translate, url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<{ zone?: AdminDeliveryZone; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) return { error: await errorText(t, res) };
    return method === 'DELETE' ? {} : { zone: (await res.json()) as AdminDeliveryZone };
  } catch {
    return { error: t('error_generic') };
  }
}

const CloseIcon = () => (
  <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
    <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" />
  </svg>
);

// Delivery zones (client-010, US-6), after design-tokens.md "אזורי משלוח":
// one card per zone with its name, an 84px fee field with ₪ outside it, city
// chips (44px, 44x44 remove button), a dashed "+ עיר" chip and the rule "a
// city is in one zone only" on the card. Every change goes through
// /api/admin/delivery-zones; the DB decides whether a city is free.
export function DeliveryZonesEditor({ zones: initial }: { zones: AdminDeliveryZone[] }) {
  const t = useTranslations('admin.delivery_zones');
  const router = useRouter();
  const [zones, setZones] = useState(initial);
  useEffect(() => setZones(initial), [initial]);

  const replace = (zone: AdminDeliveryZone) => setZones((zs) => zs.map((z) => (z.id === zone.id ? zone : z)));
  const remove = (id: string) => setZones((zs) => zs.filter((z) => z.id !== id));
  const add = (zone: AdminDeliveryZone) => setZones((zs) => [...zs, zone]);

  return (
    <div className="admin-zones">
      {zones.length === 0 ? (
        <p className="admin-warn" data-testid="zones-empty">
          {t('empty')}
        </p>
      ) : null}
      {zones.map((zone) => (
        <ZoneCard key={zone.id} zone={zone} onChange={replace} onDelete={(id) => { remove(id); router.refresh(); }} />
      ))}
      <NewZoneForm onCreated={(z) => { add(z); router.refresh(); }} />
    </div>
  );
}

function ZoneCard({ zone, onChange, onDelete }: { zone: AdminDeliveryZone; onChange: (z: AdminDeliveryZone) => void; onDelete: (id: string) => void }) {
  const t = useTranslations('admin.delivery_zones');
  const id = useId();
  const [fee, setFee] = useState(String(zone.fee));
  const [adding, setAdding] = useState(false);
  const [city, setCity] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(zone.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => setFee(String(zone.fee)), [zone.fee]);

  const url = `/api/admin/delivery-zones/${zone.id}`;
  async function patch(body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const r = await send(t, url, 'PATCH', body);
    setBusy(false);
    if (r.zone) {
      onChange(r.zone);
      setMessage({ kind: 'ok', text: okText });
      return true;
    }
    setMessage({ kind: 'error', text: r.error ?? t('error_generic') });
    return false;
  }

  async function saveFee() {
    const n = parseFee(fee);
    if (n === null) {
      setMessage({ kind: 'error', text: t('error_fee') });
      return;
    }
    if (n !== zone.fee) await patch({ fee: n }, t('saved'));
  }

  async function addCity(e: React.FormEvent) {
    e.preventDefault();
    const c = normalizeCity(city);
    if (c.length === 0 || c.length > 60) {
      setMessage({ kind: 'error', text: t('error_city') });
      return;
    }
    if (zone.cities.includes(c)) {
      setCity('');
      setAdding(false);
      return;
    }
    if (await patch({ cities: [...zone.cities, c] }, t('city_added', { city: iso(c) }))) {
      setCity('');
      setAdding(false);
    }
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (n.length === 0 || n.length > 40) {
      setMessage({ kind: 'error', text: t('error_name') });
      return;
    }
    if (n === zone.name || (await patch({ name: n }, t('saved')))) setRenaming(false);
  }

  async function del() {
    setBusy(true);
    const r = await send(t, url, 'DELETE');
    setBusy(false);
    if (r.error) setMessage({ kind: 'error', text: r.error });
    else onDelete(zone.id);
  }

  return (
    <section className="admin-zone" aria-labelledby={`${id}-name`} data-testid="zone-card" data-zone={zone.name}>
      <div className="admin-zone-h">
        <h3 id={`${id}-name`} className="admin-zone-name">
          {zone.name}
        </h3>
        <label className="admin-zone-fee">
          <input
            inputMode="numeric"
            className="num"
            dir="ltr"
            maxLength={4}
            value={fee}
            aria-label={t('fee_label', { zone: zone.name })}
            onChange={(e) => setFee(e.target.value)}
            onBlur={saveFee}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void saveFee();
              }
            }}
            disabled={busy}
            data-testid="zone-fee"
          />
          <span aria-hidden="true">₪</span>
        </label>
      </div>

      <ul className="admin-chips" aria-label={t('city_list', { zone: zone.name })}>
        {zone.cities.map((c) => (
          <li key={c} className="admin-chip">
            <span>{c}</span>
            <button
              type="button"
              aria-label={t('remove_city', { city: c })}
              disabled={busy}
              onClick={() => patch({ cities: zone.cities.filter((x) => x !== c) }, t('city_removed', { city: iso(c) }))}
            >
              <CloseIcon />
            </button>
          </li>
        ))}
        <li>
          {adding ? null : (
            <button type="button" className="admin-chip admin-chip-add" onClick={() => setAdding(true)} disabled={busy} data-testid="add-city">
              {t('add_city')}
            </button>
          )}
        </li>
      </ul>

      {adding ? (
        <form className="admin-inline-form" onSubmit={addCity} noValidate>
          <div className="admin-field">
            <label htmlFor={`${id}-city`}>{t('city_name')}</label>
            <input id={`${id}-city`} value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} autoFocus data-testid="new-city" />
          </div>
          <div className="admin-inline-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {t('add_city_submit')}
            </button>
            <button type="button" className="admin-link-button" onClick={() => { setAdding(false); setCity(''); }}>
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : null}

      <p className="admin-zone-rule">{t('one_zone_rule')}</p>

      <div className="admin-toggle-row">
        <span id={`${id}-active`}>{t('active_toggle')}</span>
        <Switch checked={zone.isActive} onChange={(v) => patch({ isActive: v }, v ? t('activated') : t('deactivated'))} labelledBy={`${id}-active`} testId="zone-active" disabled={busy} />
      </div>
      {zone.isActive ? null : <p className="admin-hint">{t('inactive_note')}</p>}

      {renaming ? (
        <form className="admin-inline-form" onSubmit={rename} noValidate>
          <div className="admin-field">
            <label htmlFor={`${id}-rename`}>{t('zone_name')}</label>
            <input id={`${id}-rename`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus data-testid="zone-rename" />
          </div>
          <div className="admin-inline-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {t('save_name')}
            </button>
            <button type="button" className="admin-link-button" onClick={() => { setRenaming(false); setName(zone.name); }}>
              {t('cancel')}
            </button>
          </div>
        </form>
      ) : confirmDelete ? (
        <div className="admin-confirm" role="group" aria-labelledby={`${id}-confirm`}>
          <p id={`${id}-confirm`} className="admin-warn">
            {t('delete_confirm', { zone: iso(zone.name) })}
          </p>
          <div className="admin-inline-actions">
            <button type="button" className="btn btn-secondary admin-danger" onClick={del} disabled={busy} data-testid="zone-delete-confirm">
              {t('delete_submit')}
            </button>
            <button type="button" className="admin-link-button" onClick={() => setConfirmDelete(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-zone-links">
          <button type="button" className="admin-link-button" onClick={() => setRenaming(true)}>
            {t('rename')}
          </button>
          <button type="button" className="admin-link-button" onClick={() => setConfirmDelete(true)}>
            {t('delete')}
          </button>
        </div>
      )}

      <p className={message?.kind === 'error' ? 'admin-form-error' : 'admin-ok'} role={message?.kind === 'error' ? 'alert' : 'status'} data-testid="zone-message" hidden={!message}>
        {message?.text}
      </p>
    </section>
  );
}

function NewZoneForm({ onCreated }: { onCreated: (z: AdminDeliveryZone) => void }) {
  const t = useTranslations('admin.delivery_zones');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [fee, setFee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    const f = parseFee(fee);
    if (n.length === 0 || n.length > 40) return setError(t('error_name'));
    if (f === null) return setError(t('error_fee'));
    setBusy(true);
    setError(null);
    const r = await send(t, '/api/admin/delivery-zones', 'POST', { name: n, fee: f, cities: [] });
    setBusy(false);
    if (r.zone) {
      onCreated(r.zone);
      setName('');
      setFee('');
      setOpen(false);
    } else setError(r.error ?? t('error_generic'));
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} data-testid="add-zone">
        {t('add_zone')}
      </button>
    );
  }
  return (
    <form className="admin-zone admin-new-zone" onSubmit={create} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="admin-zone-name">
        {t('new_zone_title')}
      </h3>
      <div className="admin-field">
        <label htmlFor={`${id}-name`}>{t('zone_name')}</label>
        <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus data-testid="new-zone-name" />
      </div>
      <div className="admin-field">
        <label htmlFor={`${id}-fee`}>{t('fee')}</label>
        <span className="admin-zone-fee">
          <input id={`${id}-fee`} inputMode="numeric" className="num" dir="ltr" maxLength={4} value={fee} onChange={(e) => setFee(e.target.value)} data-testid="new-zone-fee" />
          <span aria-hidden="true">₪</span>
        </span>
      </div>
      <p className="admin-hint">{t('new_zone_hint')}</p>
      <div className="admin-inline-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('create_submit')}
        </button>
        <button type="button" className="admin-link-button" onClick={() => { setOpen(false); setError(null); }}>
          {t('cancel')}
        </button>
      </div>
      <p className="admin-form-error" role="alert" data-testid="new-zone-message" hidden={!error}>
        {error}
      </p>
    </form>
  );
}
