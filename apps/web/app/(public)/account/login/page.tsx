import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getCustomerSession } from '@/lib/server/identity/customer-auth';
import { SignInForm } from '@/components/account/SignInForm';
import styles from '@/components/account/account.module.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

const NOTICES = ['link_invalid', 'signed_out'] as const;

export default async function CustomerLoginPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  if (await getCustomerSession()) redirect('/account');
  const t = await getTranslations('account');
  const tr = await getTranslations('registration');
  const { notice } = await searchParams;
  const shown = NOTICES.find((n) => n === notice);
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{t('login_title')}</h1>
      <p className={styles.lead}>
        {t('login_intro')}{' '}
        <Link className={styles.link} href="/">
          {tr('order_as_guest')}
        </Link>
      </p>
      {shown ? (
        <p className={shown === 'signed_out' ? styles.ok : styles.error} role="status" data-testid="login-notice">
          {t(`notice.${shown}`)}
        </p>
      ) : null}
      <SignInForm />
      <p className={styles.lead}>
        {t('no_account')}{' '}
        <Link className={styles.link} href="/register">
          {t('register_link')}
        </Link>
      </p>
    </main>
  );
}
