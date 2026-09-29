'use client';

import { useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { DayState as DayStateValue } from '@/lib/shared/types';
import type { PublicSiteSettings } from '@/lib/shared/contracts/site-settings';
import { capacityResponse } from '@/lib/shared/contracts/capacity';
import {
  checkoutErrorBody,
  createOrderRequest,
  createOrderResponse,
  type CheckoutError,
  type PublicZone,
  type TimeSlot,
} from '@/lib/shared/contracts/checkout';
import { EMPTY_CART, moveCartToDay } from '@/lib/shared/cart';
import { quoteCart } from '@/lib/shared/checkout/quote';
import { slotMeetsLeadTime } from '@/lib/shared/time/jerusalem';
import { isolate } from '@/lib/shared/text/bidi';
import { useCart } from '@/components/cart/cart-store';
import { DayStrip } from '@/components/day-state/DayStrip';
import { isSelectableDay } from '@/components/day-state/DayState';
import { BusinessDetails, CancellationExemptionNotice, NotesFieldHint, PrivacyNoticeAtCollection } from '@/components/compliance';
import { PriceWithVat } from '@/components/price';
import { formatIls } from '@/lib/shared/price/vat';
import styles from '@/components/checkout/checkout.module.css';

// The checkout screen (client-003). Everything it shows arrives from the
// server render; the client state is the form and the cart. Nothing here
// decides capacity or price: the day states come from the DB, the total shown
// is a preview from server-rendered prices (quoteCart), and the order itself is
// priced and reserved by fn_create_standard_order behind POST /api/orders.
// A refusal is shown as it is and never retried silently; when the day is
// gone the customer is sent back to the day picker with fresh day states.

type Props = {
  products: { id: string; name: string; price: number; isAvailable: boolean }[];
  days: { day: string; state: DayStateValue }[];
  range: { from: string; to: string };
  zones: PublicZone[];
  slots: TimeSlot[];
  settings: PublicSiteSettings;
  now: string;
  /** false while customer email is off (no verified sending domain): no email field. */
  collectEmail: boolean;
};

const NOT_LISTED = '__not_listed__';

// False during the server render and hydration, true after: the cart lives in
// sessionStorage, so "the cart is empty" is only known in the browser. The
// server renders the whole form (days, slots, zones, notices) as the first frame.
const noopSubscribe = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

type Field = 'day' | 'slot' | 'city' | 'address' | 'name' | 'phone' | 'email' | 'notes';
const FIELD_OF: Record<string, Field> = {
  day: 'day', slotId: 'slot', city: 'city', address: 'address', name: 'name', phone: 'phone', email: 'email', notes: 'notes',
};

function CheckoutHeader() {
  const t = useTranslations('checkout');
  return (
    <header className={styles.appbar}>
      <Link className={styles.back} href="/" aria-label={t('back_to_catalog')}>
        <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
        </svg>
      </Link>
      <h1>{t('title')}</h1>
      <span className={styles.spacer} />
    </header>
  );
}

export function CheckoutForm({ products, days: initialDays, range, zones, slots, settings, now, collectEmail }: Props) {
  const t = useTranslations('checkout');
  const router = useRouter();
  const [cart, updateCart] = useCart();
  const hydrated = useHydrated();
  const [days, setDays] = useState(initialDays);
  // null = follow the cart's day (chosen in the catalog); '' = none chosen.
  const [dayChoice, setDayChoice] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<'delivery' | 'pickup'>(zones.length > 0 ? 'delivery' : 'pickup');
  const [slotId, setSlotId] = useState<string | null>(null);
  const [city, setCity] = useState('');
  const [cityNotice, setCityNotice] = useState(false);
  const [values, setValues] = useState({ address: '', name: '', phone: '', email: '', notes: '' });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [serverError, setServerError] = useState<CheckoutError | null>(null);
  const [pickAnotherDay, setPickAnotherDay] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const dayRef = useRef<HTMLElement>(null);

  const selectableDays = useMemo(() => new Set(days.filter((d) => isSelectableDay(d.state)).map((d) => d.day)), [days]);
  const day = dayChoice === null ? (cart.day && selectableDays.has(cart.day) ? cart.day : null) : dayChoice || null;

  const productMap = useMemo(() => new Map(products.filter((p) => p.isAvailable).map((p) => [p.id, p])), [products]);
  const cityOptions = useMemo(
    () => zones.flatMap((z) => z.cities.map((c) => ({ city: c, zone: z }))).sort((a, b) => a.city.localeCompare(b.city, 'he')),
    [zones],
  );
  const zone = fulfillment === 'delivery' ? (cityOptions.find((o) => o.city === city)?.zone ?? null) : null;
  const quote = quoteCart(cart.lines, productMap, zone?.fee ?? 0);
  const nowDate = useMemo(() => new Date(now), [now]);

  if (hydrated && cart.lines.length === 0) {
    return (
      <main id="main" className={styles.main}>
        <CheckoutHeader />
        <section className={styles.empty} data-testid="checkout-empty">
          <h2>{t('empty_title')}</h2>
          <p>{t('empty_body')}</p>
          <Link className="btn btn-secondary" href="/">
            {t('back_to_catalog')}
          </Link>
        </section>
      </main>
    );
  }

  function selectDay(d: string) {
    setDayChoice(d);
    setPickAnotherDay(false);
    setErrors((e) => ({ ...e, day: undefined }));
    updateCart((c) => moveCartToDay(c, d));
    if (slotId) {
      const s = slots.find((x) => x.id === slotId);
      if (s && !slotMeetsLeadTime(d, s.start, nowDate)) setSlotId(null);
    }
  }

  function chooseCity(value: string) {
    if (value === NOT_LISTED) {
      setCity('');
      setFulfillment('pickup');
      setCityNotice(true);
      return;
    }
    setCity(value);
    setCityNotice(false);
    setErrors((e) => ({ ...e, city: undefined }));
  }

  async function refreshDays() {
    try {
      const res = await fetch(`/api/capacity?from=${range.from}&to=${range.to}`, { cache: 'no-store' });
      const parsed = capacityResponse.safeParse(await res.json());
      if (parsed.success) setDays(parsed.data.days.map((d) => ({ day: d.day, state: d.state })));
    } catch {
      // Keep the states we have; the DB refuses a gone day again anyway.
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setServerError(null);
    const body = {
      items: quote.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      day: day ?? '',
      slotId: slotId ?? '',
      fulfillment,
      ...(fulfillment === 'delivery' ? { city, address: values.address } : {}),
      name: values.name,
      phone: values.phone,
      email: values.email,
      ...(values.notes.trim() ? { notes: values.notes } : {}),
    };
    const parsed = createOrderRequest.safeParse(body);
    if (!parsed.success || quote.missing.length > 0) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.success ? [] : parsed.error.issues) {
        const f = FIELD_OF[String(issue.path[0])];
        if (!f || next[f]) continue;
        next[f] = f === 'phone' || f === 'email' || f === 'day' || f === 'slot' || f === 'city' ? t(`field_errors.${f}`) : t('field_errors.required');
      }
      setErrors(next);
      if (quote.missing.length > 0) setServerError('product_unavailable');
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.status === 201) {
        const ok = createOrderResponse.safeParse(json);
        if (ok.success) {
          router.push(`/order/${ok.data.token}`);
          updateCart(() => EMPTY_CART);
          return;
        }
      }
      const err = checkoutErrorBody.safeParse(json);
      const code: CheckoutError = err.success ? err.data.error : 'server_error';
      setServerError(code);
      if (err.success && err.data.pickAnotherDay) {
        setPickAnotherDay(true);
        setDayChoice('');
        setSlotId(null);
        await refreshDays();
        dayRef.current?.scrollIntoView({ block: 'start' });
        dayRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
      }
      setSubmitting(false);
    } catch {
      setServerError('server_error');
      setSubmitting(false);
    }
  }

  const fieldProps = (f: Field) => ({
    'aria-invalid': errors[f] ? true : undefined,
    'aria-describedby': [`${f}-hint`, errors[f] ? `${f}-error` : ''].filter(Boolean).join(' ') || undefined,
  });
  const errorText = (f: Field) =>
    errors[f] ? (
      <p id={`${f}-error`} className={styles.error}>
        {errors[f]}
      </p>
    ) : null;
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const anyDay = days.some((d) => isSelectableDay(d.state));

  return (
    <main id="main" className={styles.main}>
      <CheckoutHeader />
      <form className={styles.form} onSubmit={onSubmit} noValidate data-testid="checkout-form">
        <div className={styles.seg} role="group" aria-label={t('delivery_or_pickup')}>
          {(['delivery', 'pickup'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={fulfillment === f}
              disabled={f === 'delivery' && zones.length === 0}
              onClick={() => {
                setFulfillment(f);
                if (f === 'delivery') setCityNotice(false);
              }}
            >
              {t(f)}
            </button>
          ))}
        </div>
        {zones.length === 0 ? <p className={styles.hint}>{t('no_zones')}</p> : null}

        <section ref={dayRef} aria-labelledby="day-label" className={styles.section}>
          <h2 id="day-label" className={styles.sectionH}>
            {t('select_date')}
          </h2>
          {pickAnotherDay && serverError ? (
            <p className={styles.alert} role="alert" data-testid="pick-another-day">
              {t(`errors.${serverError}`)}
            </p>
          ) : null}
          <DayStrip days={days} selected={day} onSelect={selectDay} labelledBy="day-label" />
          <div className={styles.legend} aria-hidden="true">
            <span><i className={`${styles.sw} ${styles.swFull}`} />{t('legend_full')}</span>
            <span><i className={`${styles.sw} ${styles.swClosed}`} />{t('legend_closed')}</span>
          </div>
          {!anyDay ? <p className={styles.hint}>{t('no_days')}</p> : null}
          {errorText('day')}
        </section>

        <section aria-labelledby="slot-label" className={styles.section}>
          <h2 id="slot-label" className={styles.sectionH}>
            {fulfillment === 'delivery' ? t('select_slot_delivery') : t('select_slot_pickup')}
          </h2>
          {slots.length === 0 ? (
            <p className={styles.hint}>{t('no_slots')}</p>
          ) : (
            <div className={styles.slots} role="group" aria-labelledby="slot-label" data-testid="slots">
              {slots.map((s) => {
                const ok = !day || slotMeetsLeadTime(day, s.start, nowDate);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`${styles.slot} num`}
                    aria-pressed={slotId === s.id}
                    disabled={!ok}
                    data-slot-id={s.id}
                    onClick={() => {
                      setSlotId(s.id);
                      setErrors((e) => ({ ...e, slot: undefined }));
                    }}
                  >
                    {t('slot_label', { start: s.start, end: s.end })}
                  </button>
                );
              })}
            </div>
          )}
          {!day && slots.length > 0 ? <p className={styles.hint}>{t('slot_needs_day')}</p> : null}
          {errorText('slot')}
        </section>

        <PrivacyNoticeAtCollection context="checkout" businessName={settings.business_name} />

        {fulfillment === 'delivery' ? (
          <section className={styles.section} aria-label={t('select_city')}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="city">
                {t('select_city')}
              </label>
              <div className={styles.select}>
                <select id="city" value={city} onChange={(e) => chooseCity(e.target.value)} {...fieldProps('city')}>
                  <option value="">{t('city_placeholder')}</option>
                  {cityOptions.map((o) => (
                    <option key={o.city} value={o.city}>
                      {o.city}
                    </option>
                  ))}
                  <option value={NOT_LISTED}>{t('city_not_listed')}</option>
                </select>
                <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
                  <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                </svg>
              </div>
              <div className={styles.fee} aria-live="polite" data-testid="zone-fee">
                {zone ? (
                  <>
                    <span>{zone.name}</span>
                    <span className="num">{t('zone_fee', { fee: formatIls(zone.fee) })}</span>
                  </>
                ) : null}
              </div>
              <p id="city-hint" className={styles.hint}>
                {t('city_hint')}
              </p>
              {errorText('city')}
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="address">
                {t('guest_fields.address')}
              </label>
              <input id="address" className={styles.input} autoComplete="street-address" maxLength={200} value={values.address} onChange={set('address')} {...fieldProps('address')} />
              <p id="address-hint" className={styles.hint}>
                {t('guest_fields.address_hint')}
              </p>
              {errorText('address')}
            </div>
          </section>
        ) : null}
        {cityNotice ? (
          <p className={styles.notice} role="status" data-testid="city-not-covered">
            {t('city_not_covered')}
          </p>
        ) : null}

        <section aria-labelledby="details-label" className={styles.section}>
          <h2 id="details-label" className={styles.sectionH}>
            {t('details_heading')}
          </h2>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="name">
              {t('guest_fields.name')}
            </label>
            <input id="name" className={styles.input} autoComplete="name" maxLength={60} value={values.name} onChange={set('name')} {...fieldProps('name')} />
            {errorText('name')}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="phone">
              {t('guest_fields.phone')}
            </label>
            <input id="phone" className={`${styles.input} ${styles.ltrInput}`} type="tel" inputMode="tel" autoComplete="tel" dir="ltr" maxLength={20} value={values.phone} onChange={set('phone')} {...fieldProps('phone')} />
            <p id="phone-hint" className={styles.hint}>
              {t('guest_fields.phone_hint')}
            </p>
            {errorText('phone')}
          </div>
          {collectEmail ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="email">
                {t('guest_fields.email')}
              </label>
              <input id="email" className={`${styles.input} ${styles.ltrInput}`} type="email" inputMode="email" autoComplete="email" dir="ltr" maxLength={254} value={values.email} onChange={set('email')} {...fieldProps('email')} />
              <p id="email-hint" className={styles.hint}>
                {t('guest_fields.email_hint')}
              </p>
              {errorText('email')}
            </div>
          ) : null}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="notes">
              {t('guest_fields.notes')}
            </label>
            <textarea id="notes" className={styles.textarea} maxLength={500} rows={3} value={values.notes} onChange={set('notes')} {...fieldProps('notes')} />
            <NotesFieldHint id="notes-hint" />
          </div>
        </section>

        <section className={styles.sumCard} aria-labelledby="summary-label" data-testid="summary">
          <h2 id="summary-label" className={styles.sectionH}>
            {t('summary_heading')}
          </h2>
          {quote.lines.map((l) => (
            <div className={styles.sumRow} key={l.productId}>
              <span>{t('line', { name: isolate(l.name), quantity: l.quantity })}</span>
              <span className="num">{formatIls(l.lineTotal)}</span>
            </div>
          ))}
          <div className={styles.sumRow}>
            <span>{fulfillment === 'pickup' ? t('pickup_line') : zone ? t('delivery_line', { city: isolate(city) }) : t('delivery')}</span>
            <span className="num" data-testid="summary-fee">{formatIls(quote.deliveryFee)}</span>
          </div>
          <div className={styles.sumTotal}>
            <b>{t('total')}</b>
            <span className={styles.big} data-testid="summary-total">
              <PriceWithVat amount={quote.total} vatStatus={settings.vat_status} />
            </span>
          </div>
          <p className={styles.fine}>{t('summary_note')}</p>
        </section>

        <CancellationExemptionNotice kind="catalog" />
        <section className={styles.biz} aria-labelledby="biz-label">
          <h2 id="biz-label" className="visually-hidden">
            {t('summary_heading')}
          </h2>
          <BusinessDetails settings={settings} variant="summary" />
        </section>

        {serverError && !pickAnotherDay ? (
          <div className={styles.alert} role="alert" data-testid="checkout-error" data-error={serverError}>
            <p>{t(`errors.${serverError}`)}</p>
            {serverError === 'product_unavailable' ? <Link href="/">{t('back_to_catalog')}</Link> : null}
          </div>
        ) : null}
        {pickAnotherDay && serverError ? (
          <div className={styles.alert} data-testid="checkout-error" data-error={serverError}>
            <p>{t(`errors.${serverError}`)}</p>
            <button type="button" className="btn btn-secondary" onClick={() => dayRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus()}>
              {t('pick_another_day')}
            </button>
          </div>
        ) : null}

        <button type="submit" className={`btn btn-primary ${styles.submit}`} disabled={submitting} data-testid="checkout-submit">
          {submitting ? t('submitting') : t('submit')}
        </button>
      </form>
    </main>
  );
}
