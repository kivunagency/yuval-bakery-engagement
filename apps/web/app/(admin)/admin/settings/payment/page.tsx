import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { loadPaymentLinkSettings } from '@/lib/server/settings/payment-links';
import { jerusalemDate, jerusalemHhmm } from '@/lib/shared/time/jerusalem';
import { shortDate } from '@/components/day-state/format';
import { PaymentLinksForm } from '@/components/admin/settings/PaymentLinksForm';

// Bit and PayBox links (settings-payment, SEC-009). Arrives with its data,
// read server-side as the admin's own JWT; saving goes through
// PUT /api/admin/settings/payment-links with a fresh TOTP code.
export default async function AdminPaymentSettingsPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.settings');
  const settings = await loadPaymentLinkSettings(await createUserClient());
  // "26.9, 14:05" in Asia/Jerusalem, isolated LTR inside the Hebrew sentence.
  const when = (iso: string | null) => (iso ? `\u2066${shortDate(jerusalemDate(new Date(iso)))}, ${jerusalemHhmm(new Date(iso))}\u2069` : null);
  return (
    <>
      <Link href="/admin/settings" className="admin-back-link" prefetch={false}>
        {t('back')}
      </Link>
      <h1 className="admin-page-title">{t('payment.title')}</h1>
      <p className="admin-lead">{t('payment.intro')}</p>
      <PaymentLinksForm settings={settings} updatedAt={{ bit: when(settings.bit.updatedAt), paybox: when(settings.paybox.updatedAt) }} />
    </>
  );
}
