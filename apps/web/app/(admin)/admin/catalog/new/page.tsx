import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { ProductEditor } from '@/components/admin/products/ProductEditor';

// New product (client-006). Photos are added on the product's own page, once
// it exists (the photo path contains the product id).
export default async function AdminNewProductPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.products');
  return (
    <>
      <Link href="/admin/catalog" className="admin-inline-link admin-prod-back">
        {t('back')}
      </Link>
      <h1 className="admin-page-title">{t('new_title')}</h1>
      <ProductEditor product={null} />
    </>
  );
}
