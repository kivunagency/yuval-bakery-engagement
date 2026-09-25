import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { ComingSoon } from '@/components/admin/ComingSoon';

// Placeholder until client-009 builds this screen. Keep requireAdminPage() here.
// Custom-cake requests (client-008) sit under this tab: the design has four tabs.
export default async function AdminOrdersPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.shell.pages');
  return (
    <ComingSoon title={t('orders')}>
      <p>
        <Link href="/admin/custom-cakes" className="admin-inline-link">
          {t('custom_cakes')}
        </Link>
      </p>
    </ComingSoon>
  );
}
