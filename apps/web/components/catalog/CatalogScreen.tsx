'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { CatalogResponse, CatalogProduct } from '@/lib/shared/contracts/catalog';
import type { CapacityResponse } from '@/lib/shared/contracts/capacity';
import { addToCart, cartCount, moveCartToDay } from '@/lib/shared/cart';
import { useCart } from '@/components/cart/cart-store';
import { DayStrip } from '@/components/day-state/DayStrip';
import { isSelectableDay } from '@/components/day-state/DayState';
import { isolatedDate, weekdayKey } from '@/components/day-state/format';
import { ProductCard, type BlockedReason } from '@/components/catalog/ProductCard';
import styles from '@/components/catalog/catalog.module.css';

// The catalog screen (client-001). Everything it shows arrives as props from
// the server render (catalog + day availability); the only client state is
// the selected day and the cart. Whether a product fits a day is read from the
// DB's answer (fittingProductIds), never computed here.

type Props = {
  businessName: string;
  catalog: CatalogResponse;
  availability: CapacityResponse;
  initialDay: string | null;
};

const CUSTOM_CAKE_AFTER = 3;

export function CatalogScreen({ businessName, catalog, availability, initialDay }: Props) {
  const t = useTranslations('catalog');
  const td = useTranslations('day_state');
  const [selected, setSelected] = useState<string | null>(initialDay);
  const [cart, updateCart] = useCart();
  const [announcement, setAnnouncement] = useState('');
  const [needDay, setNeedDay] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const days = availability.days;
  const fitsByDay = useMemo(() => new Map(days.map((d) => [d.day, new Set(d.fittingProductIds)])), [days]);
  const shortLabel = (day: string) => td('day_short', { weekday: td(`weekday_short.${weekdayKey(day)}`), date: isolatedDate(day) });

  function blockedReason(p: CatalogProduct): BlockedReason | null {
    if (!p.isAvailable) return { kind: 'out_of_stock' };
    if (!selected) return null;
    if (fitsByDay.get(selected)?.has(p.id)) return null;
    const next = days.find((d) => d.day > selected && isSelectableDay(d.state) && d.fittingProductIds.includes(p.id));
    return { kind: 'does_not_fit', day: shortLabel(selected), next: next ? shortLabel(next.day) : null };
  }

  function selectDay(day: string) {
    setSelected(day);
    setNeedDay(false);
    if (cart.lines.length > 0) updateCart((c) => moveCartToDay(c, day));
    const url = new URL(window.location.href);
    url.searchParams.set('day', day);
    window.history.replaceState(null, '', url);
  }

  function add(p: CatalogProduct) {
    if (!selected) {
      setNeedDay(true);
      stripRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
      return;
    }
    updateCart((c) => addToCart(c, p.id, selected));
    setAnnouncement(t('added', { name: p.name }));
  }

  const count = cartCount(cart);
  const qty = (id: string) => cart.lines.find((l) => l.productId === id)?.quantity ?? 0;
  const products = catalog.products;
  const customAt = Math.min(CUSTOM_CAKE_AFTER, products.length);

  return (
    <>
      <header className={styles.appbar}>
        <h1 className={styles.brand} data-testid="business-name">
          {businessName}
        </h1>
        <Link href="/checkout" className={styles.cartBtn} aria-label={t('cart_label', { count })} data-testid="cart-button">
          <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
            <path d="M216,64H176a48,48,0,0,0-96,0H40A16,16,0,0,0,24,80V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V80A16,16,0,0,0,216,64ZM128,32a32,32,0,0,1,32,32H96A32,32,0,0,1,128,32Zm88,168H40V80H80V96a8,8,0,0,0,16,0V80h64V96a8,8,0,0,0,16,0V80h40Z" />
          </svg>
          {count > 0 ? <span className={`${styles.count} num`} aria-hidden="true">{count}</span> : null}
        </Link>
      </header>

      <main id="main" className={styles.main}>
        <section aria-labelledby="days-label">
          <div className={styles.daysH}>
            <h2 id="days-label">{t('day_question')}</h2>
          </div>
          <div ref={stripRef}>
            <DayStrip days={days} selected={selected} onSelect={selectDay} labelledBy="days-label" />
          </div>
          <p className={styles.filterline} data-testid="filterline">
            {selected
              ? t.rich('filter_day', {
                  day: td('day_long', { weekday: td(`weekday_long.${weekdayKey(selected)}`), date: isolatedDate(selected) }),
                  b: (chunks) => <b>{chunks}</b>,
                })
              : t('filter_none')}
          </p>
          {needDay ? (
            <p className={styles.needDay} role="alert" data-testid="need-day">
              {t('choose_day_first')}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="products-heading">
          <h2 id="products-heading" className="visually-hidden">
            {t('products_heading')}
          </h2>
          <p className={styles.priceNote}>{catalog.vatStatus === 'licensed' ? t('price_incl_vat') : t('price_final')}</p>
          {products.length === 0 ? <p className={styles.empty}>{t('empty')}</p> : null}
          <div className={styles.cat}>
            {products.slice(0, customAt).map((p, i) => (
              <ProductCard key={p.id} product={p} wide={i === 0} blocked={blockedReason(p)} inCart={qty(p.id)} onAdd={add} />
            ))}
            <div className={styles.custom}>
              <h3>{t('custom_cake.title')}</h3>
              <p>{t('custom_cake.body')}</p>
              <Link href="/custom-cake">{t('custom_cake.cta')}</Link>
            </div>
            {products.slice(customAt).map((p) => (
              <ProductCard key={p.id} product={p} wide={false} blocked={blockedReason(p)} inCart={qty(p.id)} onAdd={add} />
            ))}
          </div>
          <p className={styles.kitchenNotice}>{t('kitchen_notice')}</p>
        </section>
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>
      </main>
    </>
  );
}
