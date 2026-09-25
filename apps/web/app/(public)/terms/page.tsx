import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LegalPage, LegalSection } from '@/components/legal-page';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('terms');
  return { title: t('title') };
}

// compliance-004: terms of use (Rule 33 item 2). Built from PRD-01 and
// compliance-spec.md; anything the spec does not settle (liability, law and
// jurisdiction, missed delivery) is a visible placeholder for legal review.
const SECTIONS = ['about', 'ordering', 'custom_cakes', 'prices', 'payment', 'delivery', 'allergens', 'liability', 'law', 'changes'] as const;
// Related pages as a list under the section, not inline in the sentence:
// a 44px link target inside running text breaks the line.
const SECTION_LINKS: Partial<Record<(typeof SECTIONS)[number], readonly ('business' | 'returns' | 'privacy')[]>> = {
  about: ['business'],
  changes: ['returns', 'privacy'],
};
const HREF = { business: '/business', returns: '/returns', privacy: '/privacy' } as const;

export default async function TermsPage() {
  const [t, settings] = await Promise.all([getTranslations('terms'), getPublicSiteSettings()]);
  const businessName = settings.business_name ?? (await getTranslations('business'))('details.name');
  return (
    <LegalPage title={t('title')} version={TEXT_VERSIONS.terms}>
      {SECTIONS.map((id) => (
        <LegalSection key={id} id={id} title={t(`sections.${id}.title`)}>
          <p>{t(`sections.${id}.body`, { businessName })}</p>
          {SECTION_LINKS[id] ? (
            <ul>
              {SECTION_LINKS[id].map((k) => (
                <li key={k}>
                  <Link href={HREF[k]}>{t(`links.${k}`)}</Link>
                </li>
              ))}
            </ul>
          ) : null}
        </LegalSection>
      ))}
    </LegalPage>
  );
}
