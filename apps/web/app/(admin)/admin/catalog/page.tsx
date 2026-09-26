import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { listProductsForAdmin } from '@/lib/server/catalog/admin-products';
import { ProductList } from '@/components/admin/products/ProductList';

// Products tab (client-006, US-12). Arrives with its data, read server-side
// as the admin's own JWT (RLS shows her unpublished products too); edits go
// through /api/admin/products and the audited DB functions.
export default async function AdminCatalogPage() {
  await requireAdminPage();
  const [t, products] = await Promise.all([getTranslations('admin.products'), createUserClient().then(listProductsForAdmin)]);
  return (
    <>
      <div className="admin-orders-head">
        <h1 className="admin-page-title">{t('title')}</h1>
        <Link href="/admin/catalog/new" className="btn btn-primary" data-testid="product-add">
          {t('add')}
        </Link>
      </div>
      <p className="admin-lead">{t('lead')}</p>
      <ProductList products={products} />
    </>
  );
}
