import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { loadBusinessSettings } from '@/lib/server/settings/business';
import { BusinessDetailsForm } from '@/components/admin/settings/BusinessDetailsForm';

// Business details (s.14C) and osek status (settings-business). Arrives with
// its data, read server-side as the admin's own JWT; saving goes through
// PUT /api/admin/settings/business.
export default async function AdminBusinessSettingsPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.settings');
  const settings = await loadBusinessSettings(await createUserClient());
  return (
    <>
      <Link href="/admin/settings" className="admin-back-link" prefetch={false}>
        {t('back')}
      </Link>
      <h1 className="admin-page-title">{t('business.title')}</h1>
      <p className="admin-lead">{t('business.intro')}</p>
      <BusinessDetailsForm settings={settings} />
    </>
  );
}
