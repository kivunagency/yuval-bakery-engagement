import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CancellationExemptionNotice } from '@/components/compliance';
import { LegalPage, LegalSection } from '@/components/legal-page';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import { pageMetadata } from '@/lib/server/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('returns_policy');
  return pageMetadata({ path: '/returns', title: t('title'), key: 'returns' });
}

// compliance-004: cancellation and returns policy (Rule 33 item 5,
// compliance-spec.md section 9). Same wording as the notice at checkout
// (the component itself is rendered here), same version.
const SECTIONS = ['before_payment', 'after_payment', 'goodwill', 'defects', 'business_cancels', 'how'] as const;

export default async function ReturnsPage() {
  const t = await getTranslations('returns_policy');
  return (
    <LegalPage title={t('title')} version={TEXT_VERSIONS.cancellation}>
      <p>{t('intro')}</p>
      <CancellationExemptionNotice kind="catalog" headingId="returns-catalog-heading" title={t('catalog_title')} showPolicyLink={false} />
      <CancellationExemptionNotice kind="custom_cake" headingId="returns-custom-heading" title={t('custom_cake_title')} showPolicyLink={false} />
      {SECTIONS.map((id) => (
        <LegalSection key={id} id={id} title={t(`sections.${id}.title`)}>
          <p>{t(`sections.${id}.body`)}</p>
        </LegalSection>
      ))}
    </LegalPage>
  );
}
