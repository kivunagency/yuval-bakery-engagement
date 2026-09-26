'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { isolate } from '@/lib/shared/text/bidi';
import type { AdminProduct } from '@/lib/shared/contracts/admin-products';
import { ProductForm } from '@/components/admin/products/ProductForm';
import { PhotoManager } from '@/components/admin/products/PhotoManager';
import { send } from '@/components/admin/products/api';

// One product's page (client-006): the form, its photos and the delete
// action. Holds the product as the server last returned it, so a photo change
// updates the "before it can be published" list next to the publish switch.
// product null = the "new product" page: after creating, go to its own page
// to add photos.
export function ProductEditor({ product: initial }: { product: AdminProduct | null }) {
  const router = useRouter();
  const [product, setProduct] = useState(initial);

  return (
    <div className="admin-prod-editor">
      <ProductForm
        key={product?.id ?? 'new'}
        product={product}
        onSaved={(p, created) => {
          if (created) {
            router.push(`/admin/catalog/${p.id}?created=1`);
            return;
          }
          setProduct(p);
          router.refresh();
        }}
      />
      {product ? (
        <>
          <PhotoManager product={product} onChange={setProduct} />
          <DeleteProduct product={product} onDeleted={() => { router.push('/admin/catalog'); router.refresh(); }} />
        </>
      ) : null}
    </div>
  );
}

function DeleteProduct({ product, onDeleted }: { product: AdminProduct; onDeleted: () => void }) {
  const t = useTranslations('admin.products');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    setBusy(true);
    setError(null);
    const r = await send(t, `/api/admin/products/${product.id}`, 'DELETE');
    setBusy(false);
    if (r.error) setError(r.error);
    else onDeleted();
  }

  return (
    <section className="admin-prod-section admin-prod-delete" aria-label={t('delete')}>
      {confirm ? (
        <div className="admin-confirm" role="group" aria-labelledby="product-delete-q">
          <p id="product-delete-q" className="admin-confirm-title">
            {t('delete_confirm', { name: isolate(product.name) })}
          </p>
          <div className="admin-inline-actions">
            <button type="button" className="btn btn-secondary admin-danger" onClick={del} disabled={busy} data-testid="product-delete-confirm">
              {t('delete_submit')}
            </button>
            <button type="button" className="admin-link-button" onClick={() => setConfirm(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="admin-link-button admin-prod-delete-link" onClick={() => setConfirm(true)} data-testid="product-delete">
          {t('delete')}
        </button>
      )}
      <p className="admin-form-error" role="alert" hidden={!error}>
        {error}
      </p>
    </section>
  );
}
