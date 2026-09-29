import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { getProductForAdmin } from '@/lib/server/catalog/admin-products';
import { productIdParam } from '@/lib/shared/contracts/admin-products';
import { ProductEditor } from '@/components/admin/products/ProductEditor';

// One product (client-006): details, price and time, allergens, visibility,
// photos with alt text, delete. Arrives with its data (server read as the
// admin's own JWT).
export default async function AdminProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  await requireAdminPage();
  const id = productIdParam.safeParse((await params).id);
  if (!id.success) notFound();
  const product = await getProductForAdmin(await createUserClient(), id.data);
  if (!product) notFound();
  const t = await getTranslations('admin.products');
  const created = (await searchParams).created === '1';
  return (
    <>
      <Link href="/admin/catalog" className="admin-inline-link admin-prod-back">
        {t('back')}
      </Link>
      <h1 className="admin-page-title">
        {t('edit_title')}: <bdi>{product.name}</bdi>
      </h1>
      {created ? (
        <p className="admin-ok admin-prod-created" role="status" data-testid="product-created">
          {t('created')}
        </p>
      ) : null}
      <ProductEditor product={product} />
    </>
  );
}
