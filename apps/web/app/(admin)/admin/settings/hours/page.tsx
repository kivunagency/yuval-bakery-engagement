import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { loadOrderSettings } from '@/lib/server/settings/order-settings';
import { TimeSlotsForm } from '@/components/admin/settings/TimeSlotsForm';
import { OrderRulesForm } from '@/components/admin/settings/OrderRulesForm';

// Time slots and order rules (settings-slots). Arrives with its data, read
// server-side as the admin's own JWT; saving goes through
// PUT /api/admin/settings/time-slots and /order-rules. earliest_slot_time is
// shown, never edited: it follows the first slot (api-003).
export default async function AdminHoursSettingsPage() {
  await requireAdminPage();
  const [t, settings] = await Promise.all([getTranslations('admin.settings'), createUserClient().then(loadOrderSettings)]);
  const first = settings.slots[0]?.start ?? null;
  return (
    <>
      <Link href="/admin/settings" className="admin-back-link" prefetch={false}>
        {t('back')}
      </Link>
      <h1 className="admin-page-title">{t('hours.title')}</h1>
      <h2 className="admin-section-title admin-section-title-first">{t('hours.slots_title')}</h2>
      <p className="admin-lead">{t('hours.slots_intro')}</p>
      <p className="admin-hint" data-testid="earliest-slot">
        {first ? t('hours.earliest', { time: `⁦${first}⁩` }) : t('hours.earliest_none')}
      </p>
      <TimeSlotsForm slots={settings.slots} />
      <h2 className="admin-section-title">{t('hours.rules_title')}</h2>
      <p className="admin-lead">{t('hours.rules_intro')}</p>
      <OrderRulesForm rules={settings.rules} />
    </>
  );
}
