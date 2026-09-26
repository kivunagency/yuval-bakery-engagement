'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/admin/capacity/Switch';
import { formatIls } from '@/lib/shared/price/vat';
import { publishBlockers, type AdminProduct } from '@/lib/shared/contracts/admin-products';
import { send } from '@/components/admin/products/api';

// The Products tab (client-006, US-12): one row per product with its first
// photo, name, price and two states (published or not, available or sold
// out). "Sold out" is the everyday switch, so it sits on the row; everything
// else is on the product's own page. Arrives with its data from the server.
export function ProductList({ products: initial }: { products: AdminProduct[] }) {
  const t = useTranslations('admin.products');
  const [products, setProducts] = useState(initial);
  useEffect(() => setProducts(initial), [initial]);

  if (products.length === 0) {
    return (
      <p className="admin-warn" data-testid="products-empty">
        {t('empty')}
      </p>
    );
  }
  return (
    <ul className="admin-prod-list" aria-label={t('list_label')}>
      {products.map((p) => (
        <ProductRow key={p.id} product={p} onChange={(np) => setProducts((ps) => ps.map((x) => (x.id === np.id ? np : x)))} />
      ))}
    </ul>
  );
}

function ProductRow({ product, onChange }: { product: AdminProduct; onChange: (p: AdminProduct) => void }) {
  const t = useTranslations('admin.products');
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photo = product.photos[0];
  const blockers = publishBlockers(product);

  async function toggleAvailable(next: boolean) {
    setBusy(true);
    setError(null);
    const r = await send(t, `/api/admin/products/${product.id}`, 'PATCH', { isAvailable: next });
    setBusy(false);
    if (r.product) onChange(r.product);
    else setError(r.error ?? t('error_generic'));
  }

  return (
    <li className="admin-prod" data-testid="product-row" data-product-id={product.id}>
      <div className="admin-prod-main">
        <div className="admin-prod-thumb" aria-hidden="true">
          {/* Public bucket file, served by Storage directly (no image optimizer on Netlify free). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {photo?.url ? <img src={photo.url} alt="" width={72} height={72} loading="lazy" decoding="async" /> : null}
        </div>
        <div className="admin-prod-text">
          <h2 className="admin-prod-name" id={`${id}-name`}>
            <bdi>{product.name}</bdi>
          </h2>
          <p className="admin-prod-price num">{formatIls(product.price)}</p>
          <p className="admin-prod-tags">
            <span className={product.isPublished ? 'admin-prod-tag admin-prod-tag-on' : 'admin-prod-tag'} data-testid="product-published">
              {product.isPublished ? t('status_published') : t('status_draft')}
            </span>
            {product.isAvailable ? null : (
              <span className="admin-prod-tag admin-prod-tag-warn" data-testid="product-paused">
                {t('status_paused')}
              </span>
            )}
          </p>
        </div>
      </div>
      {photo ? null : <p className="admin-hint admin-prod-note">{t('no_photo')}</p>}
      {!product.isPublished && blockers.length > 0 ? (
        <p className="admin-hint admin-prod-note" data-testid="product-blockers">
          {blockers.map((b) => t(`blocker_${b}`)).join(' ')}
        </p>
      ) : null}
      <div className="admin-toggle-row">
        <span id={`${id}-avail`}>{t('availability_toggle')}</span>
        <Switch checked={product.isAvailable} onChange={toggleAvailable} labelledBy={`${id}-avail ${id}-name`} testId="product-available" disabled={busy} />
      </div>
      <Link href={`/admin/catalog/${product.id}`} className="btn btn-secondary admin-prod-edit" aria-describedby={`${id}-name`} data-testid="product-edit">
        {t('edit')}
      </Link>
      <p className="admin-form-error" role="alert" hidden={!error}>
        {error}
      </p>
    </li>
  );
}
