import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { ComingSoon } from '@/components/admin/ComingSoon';

// Placeholder until client-008 builds this screen. Keep requireAdminPage() here.
export default async function AdminCustomCakesPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.shell.pages');
  return <ComingSoon title={t('custom_cakes')} />;
}
