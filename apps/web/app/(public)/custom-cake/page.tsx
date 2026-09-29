import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PrivacyNoticeAtCollection } from '@/components/compliance';
import { CustomCakeForm } from '@/components/custom-cake/CustomCakeForm';
import styles from '@/components/custom-cake/custom-cake.module.css';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { readFeatures } from '@/lib/server/features';
import { earliestDeliveryDate } from '@/lib/shared/time/jerusalem';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('custom_cake');
  return { title: t('meta_title') };
}

// Custom-cake request (client-002, PRD US-2), linked from the catalog's
// custom-cake row. Server component: the privacy notice at collection (s.11)
// comes before the first personal field, with the business name from the
// settings. The earliest date is the same rule the DB trigger enforces
// (earliestDeliveryDate is kept equal to fn_earliest_delivery_date by a
// parity test); it only sets the date picker's minimum, the DB decides.
export default async function CustomCakePage() {
  const [t, settings] = await Promise.all([getTranslations('custom_cake'), getPublicSiteSettings()]);
  return (
    <main className="page" id="main">
      <header className={styles.header}>
        <Link href="/" className={styles.back} prefetch={false}>
          {t('back')}
        </Link>
        <h1>{t('title')}</h1>
        <p className={styles.intro}>{t('intro')}</p>
      </header>
      <div className={styles.stack}>
        <PrivacyNoticeAtCollection context="custom_cake" businessName={settings.business_name} />
        <CustomCakeForm earliestDate={earliestDeliveryDate(new Date())} collectEmail={readFeatures().customerEmail} />
      </div>
    </main>
  );
}
