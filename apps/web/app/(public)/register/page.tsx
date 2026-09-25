import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCustomerSession } from '@/lib/server/identity/customer-auth';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { PrivacyNoticeAtCollection } from '@/components/compliance';
import { RegisterForm } from '@/components/account/RegisterForm';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import styles from '@/components/account/account.module.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// client-005: optional registration, separate from checkout (PRD US-4). The
// privacy notice (s.11) comes before the first personal-data field.
export default async function RegisterPage() {
  if (await getCustomerSession()) redirect('/account');
  const t = await getTranslations('registration');
  const settings = await getPublicSiteSettings();
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{t('title')}</h1>
      <p className={styles.lead} data-testid="registration-optional">
        {t('optional_note')}{' '}
        <Link className={styles.link} href="/">
          {t('order_as_guest')}
        </Link>
      </p>
      <p className={styles.lead}>{t('benefits')}</p>
      <PrivacyNoticeAtCollection context="registration" businessName={settings.business_name} />
      <RegisterForm privacyNoticeVersion={TEXT_VERSIONS.privacy} />
    </main>
  );
}
