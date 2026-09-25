import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { listZonesForAdmin } from '@/lib/server/delivery/admin-zones';
import { DeliveryZonesEditor } from '@/components/admin/delivery/DeliveryZonesEditor';

// Admin settings (client-010): delivery zones by city with a flat fee (US-6).
// Arrives with its data (server-rendered as the admin's own JWT); only the
// edits go through /api/admin/delivery-zones.
export default async function AdminSettingsPage() {
  await requireAdminPage();
  const [tPages, t] = await Promise.all([getTranslations('admin.shell.pages'), getTranslations('admin.delivery_zones')]);
  const zones = await listZonesForAdmin(await createUserClient());
  return (
    <>
      <h1 className="admin-page-title">{tPages('settings')}</h1>
      <h2 className="admin-section-title admin-section-title-first">{t('title')}</h2>
      <p className="admin-lead">{t('intro')}</p>
      <DeliveryZonesEditor zones={zones} />
    </>
  );
}
