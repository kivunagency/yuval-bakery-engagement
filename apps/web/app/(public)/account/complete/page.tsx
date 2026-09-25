import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { loadMyAccount } from '@/lib/server/identity/account';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { PrivacyNoticeAtCollection } from '@/components/compliance';
import { CompleteDetailsForm } from '@/components/account/CompleteDetailsForm';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import styles from '@/components/account/account.module.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// A confirmed user without a profile: the phone was already taken, or the
// sign-up data could not be used. Same notice and fields as registration.
export default async function CompleteDetailsPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const account = await loadMyAccount();
  if (!account) redirect('/account/login');
  if (account.profile) redirect('/account');
  const t = await getTranslations('account');
  const settings = await getPublicSiteSettings();
  const { reason } = await searchParams;
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{t('complete_title')}</h1>
      <p className={styles.lead}>{t('complete_intro')}</p>
      {reason === 'phone_taken' ? (
        <p className={styles.error} role="status" data-testid="complete-phone-taken">
          {t('complete_phone_taken')}
        </p>
      ) : null}
      <PrivacyNoticeAtCollection context="registration" businessName={settings.business_name} />
      <CompleteDetailsForm privacyNoticeVersion={TEXT_VERSIONS.privacy} />
    </main>
  );
}
