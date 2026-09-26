import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { listZonesForAdmin } from '@/lib/server/delivery/admin-zones';
import { loadBusinessSettings } from '@/lib/server/settings/business';
import { loadPaymentLinkSettings } from '@/lib/server/settings/payment-links';
import { loadOrderSettings } from '@/lib/server/settings/order-settings';
import { ORDER_RULE_NAMES } from '@/lib/shared/contracts/order-settings';
import { vapidPublicKey } from '@/lib/server/notification/config';
import { countAdminPushDevices } from '@/lib/server/notification/subscriptions';
import { DeliveryZonesEditor } from '@/components/admin/delivery/DeliveryZonesEditor';
import { PushSubscribeCard } from '@/components/admin/push/PushSubscribeCard';
import { SettingsNav } from '@/components/admin/settings/SettingsNav';
import { BUSINESS_FIELDS } from '@/lib/shared/contracts/business-settings';

// Admin settings. Links to the sections with their own screen (business
// details, payment links, hours and order rules), delivery zones by city with a flat fee (client-010, US-6) and
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
  const [zones, deviceCount, business, payment, order] = await Promise.all([
    listZonesForAdmin(supabase),
    countAdminPushDevices(supabase, session.userId),
    loadBusinessSettings(supabase),
    loadPaymentLinkSettings(supabase),
    loadOrderSettings(supabase),
  ]);
  const rulesUnconfirmed = ORDER_RULE_NAMES.some((r) => !order.rules[r].confirmed);
  const firstSlot = order.slots[0]?.start;
  const missing = BUSINESS_FIELDS.filter((f) => !business[f]).length;
  const linksHidden = [payment.bit, payment.paybox].filter((l) => !l.shownToCustomers).length;
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
          {
            href: '/admin/settings/payment',
            title: tSettings('payment.title'),
            status: linksHidden > 0 ? tSettings('payment.status_missing', { count: linksHidden }) : tSettings('payment.status_done'),
            attention: linksHidden > 0,
            testId: 'settings-link-payment',
          },
          {
            href: '/admin/settings/hours',
            title: tSettings('hours.title'),
            status: [
              firstSlot ? tSettings('hours.status_slots', { count: order.slots.length, time: `\u2066${firstSlot}\u2069` }) : tSettings('hours.status_no_slots'),
              rulesUnconfirmed ? tSettings('hours.status_rules_unconfirmed') : null,
            ]
              .filter(Boolean)
              .join(' '),
            attention: !firstSlot || rulesUnconfirmed,
            testId: 'settings-link-hours',
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
