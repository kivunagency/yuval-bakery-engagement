import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import type { CatalogProduct } from '@/lib/shared/contracts/catalog';
import { AllergenChips } from '@/components/catalog/AllergenChips';
import { ProductPhoto } from '@/components/catalog/ProductPhoto';
import { PriceAmount } from '@/components/price';
import { QuantityStepper } from '@/components/cart/QuantityStepper';
import styles from '@/components/catalog/catalog.module.css';

// One product (design-tokens.md, "כרטיס מוצר"). Three states: orderable,
// sold out (Yuval paused it) and "does not fit on the selected day" (the DB
// said one unit does not fit). The last two look the same: the product stays
// in the catalog, greyed, with a note under the photo and a disabled button.
// Once the product is in the cart the add button becomes minus / quantity /
// plus; a blocked product already in the cart keeps its minus (it can be
// lowered or removed) and loses its plus.

export type BlockedReason = { kind: 'out_of_stock' } | { kind: 'does_not_fit'; day: string; next: string | null };

type Props = {
  product: CatalogProduct;
  wide: boolean;
  blocked: BlockedReason | null;
  inCart: number;
  onAdd: (product: CatalogProduct) => void;
  onIncrease: (product: CatalogProduct) => void;
  onDecrease: (product: CatalogProduct) => void;
};

export function ProductCard({ product, wide, blocked, inCart, onAdd, onIncrease, onDecrease }: Props) {
  const t = useTranslations('catalog');
  // Keep keyboard focus when the add button and the stepper replace each other.
  const addRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'add' | 'plus' | null>(null);
  const hasLine = inCart > 0;
  useEffect(() => {
    if (focusNext.current === 'plus' && hasLine) plusRef.current?.focus();
    if (focusNext.current === 'add' && !hasLine) addRef.current?.focus();
    focusNext.current = null;
  }, [hasLine]);
  const headingId = `p-${product.id}`;
  const note =
    blocked?.kind === 'out_of_stock'
      ? t('out_of_stock')
      : blocked?.kind === 'does_not_fit'
        ? blocked.next
          ? t('does_not_fit_until', { day: blocked.day, next: blocked.next })
          : t('does_not_fit', { day: blocked.day })
        : null;

  return (
    <article
      className={[styles.p, wide ? styles.wide : '', blocked ? styles.out : ''].filter(Boolean).join(' ')}
      aria-labelledby={headingId}
      data-testid="product-card"
      data-product-id={product.id}
      data-blocked={blocked?.kind ?? 'none'}
    >
      <ProductPhoto photo={product.photos[0]} eager={wide} />
      <div className={styles.row}>
        <h3 id={headingId}>{product.name}</h3>
        <PriceAmount amount={product.price} className={styles.price} />
      </div>
      {note ? <p className={styles.stateNote}>{note}</p> : null}
      <AllergenChips contains={product.allergens} mayContain={product.mayContain} notes={product.allergenNotes} />
      {product.ingredients || product.description ? (
        <details className={styles.details}>
          <summary>{t('details_summary')}</summary>
          {product.description ? <p>{product.description}</p> : null}
          {product.ingredients ? (
            <p>
              <b>{t('ingredients_label')}: </b>
              {product.ingredients}
            </p>
          ) : null}
        </details>
      ) : null}
      {hasLine ? (
        <div className={styles.stepperRow}>
          <QuantityStepper
            ref={plusRef}
            name={product.name}
            quantity={inCart}
            increaseDisabled={blocked !== null}
            onIncrease={() => onIncrease(product)}
            onDecrease={() => {
              if (inCart <= 1) focusNext.current = 'add';
              onDecrease(product);
            }}
          />
        </div>
      ) : (
        <button
          ref={addRef}
          type="button"
          className={styles.add}
          disabled={blocked !== null}
          aria-describedby={headingId}
          onClick={() => {
            focusNext.current = 'plus';
            onAdd(product);
          }}
        >
          {blocked ? t('unavailable') : t('add')}
        </button>
      )}
    </article>
  );
}
