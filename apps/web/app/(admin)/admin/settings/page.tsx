import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { listZonesForAdmin } from '@/lib/server/delivery/admin-zones';
import { loadBusinessSettings } from '@/lib/server/settings/business';
import { vapidPublicKey } from '@/lib/server/notification/config';
import { countAdminPushDevices } from '@/lib/server/notification/subscriptions';
import { DeliveryZonesEditor } from '@/components/admin/delivery/DeliveryZonesEditor';
import { PushSubscribeCard } from '@/components/admin/push/PushSubscribeCard';
import { SettingsNav } from '@/components/admin/settings/SettingsNav';
import { BUSINESS_FIELDS } from '@/lib/shared/contracts/business-settings';

// Admin settings. Links to the sections with their own screen (business
// details), delivery zones by city with a flat fee (client-010, US-6) and
// this admin's push devices (client-012). Arrives with its data, read
// server-side as the admin's own JWT; only edits go through the admin APIs.
export default async function AdminSettingsPage() {
  const session = await requireAdminPage();
  const [tPages, t, tSettings] = await Promise.all([
    getTranslations('admin.shell.pages'),
    getTranslations('admin.delivery_zones'),
    getTranslations('admin.settings'),
  ]);
  const supabase = await createUserClient();
  const [zones, deviceCount, business] = await Promise.all([
    listZonesForAdmin(supabase),
    countAdminPushDevices(supabase, session.userId),
    loadBusinessSettings(supabase),
  ]);
  const missing = BUSINESS_FIELDS.filter((f) => !business[f]).length;
  return (
    <>
      <h1 className="admin-page-title">{tPages('settings')}</h1>
      <SettingsNav
        label={tSettings('nav_label')}
        items={[
          {
            href: '/admin/settings/business',
            title: tSettings('business.title'),
            status: [
              missing > 0 ? tSettings('business.status_missing', { count: missing }) : tSettings('business.status_done'),
              business.vatStatusConfirmed ? null : tSettings('business.status_vat_unconfirmed'),
            ]
              .filter(Boolean)
              .join(' '),
            attention: missing > 0 || !business.vatStatusConfirmed,
            testId: 'settings-link-business',
          },
        ]}
      />
      <h2 className="admin-section-title">{t('title')}</h2>
      <p className="admin-lead">{t('intro')}</p>
      <DeliveryZonesEditor zones={zones} />
      <PushSubscribeCard vapidPublicKey={vapidPublicKey()} deviceCount={deviceCount} />
    </>
  );
}
