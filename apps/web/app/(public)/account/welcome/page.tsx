import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { loadMyAccount } from '@/lib/server/identity/account';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { PreferencesForm } from '@/components/account/PreferencesForm';
import { monthNames } from '@/components/account/month-names';
import styles from '@/components/account/account.module.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Second step of registration, right after the email is confirmed: the
// optional s.30A choice, as its own act (source 'registration').
export default async function WelcomePage() {
  const account = await loadMyAccount();
  if (!account) redirect('/account/login');
  if (!account.profile) redirect('/account/complete');
  const t = await getTranslations('registration');
  const tb = await getTranslations('business');
  const settings = await getPublicSiteSettings();
  const p = account.profile;
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{t('welcome_title')}</h1>
      <p className={styles.lead}>{t('welcome_intro')}</p>
      <section className={styles.card} aria-labelledby="welcome-marketing">
        <h2 id="welcome-marketing">{t('marketing_title')}</h2>
        <PreferencesForm
          source="registration"
          businessName={settings.business_name ?? tb('details.name')}
          optedIn={p.marketing_opt_in}
          birthday={{ day: p.birthday_day, month: p.birthday_month }}
          anniversary={{ day: p.anniversary_day, month: p.anniversary_month }}
          monthNames={monthNames(await getLocale())}
        />
      </section>
    </main>
  );
}
