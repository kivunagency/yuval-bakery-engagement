import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { vapidPublicKey } from '@/lib/server/notification/config';
import { countAdminPushDevices } from '@/lib/server/notification/subscriptions';
import { ComingSoon } from '@/components/admin/ComingSoon';
import { PushSubscribeCard } from '@/components/admin/push/PushSubscribeCard';

// Settings. The rest of this screen is client-010's (placeholder below); the
// push section is client-012's. Arrives with its data: the VAPID public key
// and this admin's active push devices are read here, on the server.
export default async function AdminSettingsPage() {
  const session = await requireAdminPage();
  const t = await getTranslations('admin.shell.pages');
  const deviceCount = await countAdminPushDevices(await createUserClient(), session.userId);
  return (
    <ComingSoon title={t('settings')}>
      <PushSubscribeCard vapidPublicKey={vapidPublicKey()} deviceCount={deviceCount} />
    </ComingSoon>
  );
}
