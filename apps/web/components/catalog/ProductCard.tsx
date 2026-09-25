import { useTranslations } from 'next-intl';
import type { CatalogProduct } from '@/lib/shared/contracts/catalog';
import { AllergenChips } from '@/components/catalog/AllergenChips';
import { ProductPhoto } from '@/components/catalog/ProductPhoto';
import { Price } from '@/components/price/Price';
import styles from '@/components/catalog/catalog.module.css';

// One product (design-tokens.md, "כרטיס מוצר"). Three states: orderable,
// sold out (Yuval paused it) and "does not fit on the selected day" (the DB
// said one unit does not fit). The last two look the same: the product stays
// in the catalog, greyed, with a note under the photo and a disabled button.

export type BlockedReason = { kind: 'out_of_stock' } | { kind: 'does_not_fit'; day: string; next: string | null };

type Props = {
  product: CatalogProduct;
  wide: boolean;
  blocked: BlockedReason | null;
  inCart: number;
  onAdd: (product: CatalogProduct) => void;
};

export function ProductCard({ product, wide, blocked, inCart, onAdd }: Props) {
  const t = useTranslations('catalog');
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
        <Price amount={product.price} className={styles.price} />
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
      <button
        type="button"
        className={styles.add}
        disabled={blocked !== null}
        aria-describedby={headingId}
        onClick={() => onAdd(product)}
      >
        {blocked ? t('unavailable') : t('add')}
        {!blocked && inCart > 0 ? <span className={`${styles.inCart} num`}>{inCart}</span> : null}
      </button>
    </article>
  );
}
