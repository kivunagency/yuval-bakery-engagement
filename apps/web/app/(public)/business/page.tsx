import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BusinessDetails, CancellationExemptionNotice } from '@/components/compliance';
import { LegalPage, LegalSection } from '@/components/legal-page';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { pageMetadata } from '@/lib/server/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('business.page');
  return pageMetadata({ path: '/business', title: t('title'), key: 'business' });
}

// compliance-002: business details under Consumer Protection Law s.14C, linked
// from the footer and from the checkout summary.
export default async function BusinessPage() {
  const [t, settings] = await Promise.all([getTranslations('business'), getPublicSiteSettings()]);
  return (
    <LegalPage title={t('page.title')}>
      <LegalSection id="business-details" title={t('details.contact')}>
        <BusinessDetails settings={settings} variant="full" />
      </LegalSection>
      <LegalSection id="business-ordering" title={t('page.ordering_title')}>
        <p>{t('page.ordering_body')}</p>
        <p>{t('page.prices_body')}</p>
        <p>{t('page.delivery_body')}</p>
        <p>{t('page.payment_body')}</p>
      </LegalSection>
      <CancellationExemptionNotice kind="catalog" />
    </LegalPage>
  );
}
