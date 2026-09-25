import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { listZonesForAdmin } from '@/lib/server/delivery/admin-zones';
import { vapidPublicKey } from '@/lib/server/notification/config';
import { countAdminPushDevices } from '@/lib/server/notification/subscriptions';
import { DeliveryZonesEditor } from '@/components/admin/delivery/DeliveryZonesEditor';
import { PushSubscribeCard } from '@/components/admin/push/PushSubscribeCard';

// Admin settings. Delivery zones by city with a flat fee (client-010, US-6)
// and this admin's push devices (client-012). Arrives with its data, read
// server-side as the admin's own JWT; only edits go through the admin APIs.
export default async function AdminSettingsPage() {
  const session = await requireAdminPage();
  const [tPages, t] = await Promise.all([getTranslations('admin.shell.pages'), getTranslations('admin.delivery_zones')]);
  const supabase = await createUserClient();
  const [zones, deviceCount] = await Promise.all([listZonesForAdmin(supabase), countAdminPushDevices(supabase, session.userId)]);
  return (
    <>
      <h1 className="admin-page-title">{tPages('settings')}</h1>
      <h2 className="admin-section-title admin-section-title-first">{t('title')}</h2>
      <p className="admin-lead">{t('intro')}</p>
      <DeliveryZonesEditor zones={zones} />
      <PushSubscribeCard vapidPublicKey={vapidPublicKey()} deviceCount={deviceCount} />
    </>
  );
}
