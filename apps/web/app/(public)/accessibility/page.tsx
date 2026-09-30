import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ContactBlock } from '@/components/contact-block';
import { LegalPage, LegalSection } from '@/components/legal-page';
import { ACCESSIBILITY_STATEMENT_UPDATED } from '@/lib/shared/compliance/versions';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { pageMetadata } from '@/lib/server/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('accessibility.statement');
  return pageMetadata({ path: '/accessibility', title: t('title'), key: 'accessibility' });
}

// compliance-003: accessibility statement (Rule 33 items 9-10, IS 5568).
// Describes what was actually done; does not claim full conformance, and does
// not assert the small-business exemption (amount and applicability
// unverified). Contact goes to the owner herself: a sole trader, so no
// accessibility coordinator is named (that duty starts at 25 employees).
const DONE = ['language', 'contrast', 'keyboard', 'targets', 'motion', 'alt', 'allergens', 'state'] as const;
const LIMITS = ['not_audited', 'external', 'content'] as const;

export default async function AccessibilityPage() {
  const [t, format, settings] = await Promise.all([getTranslations('accessibility.statement'), getFormatter(), getPublicSiteSettings()]);
  const updated = format.dateTime(new Date(`${ACCESSIBILITY_STATEMENT_UPDATED}T12:00:00Z`), { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <LegalPage title={t('title')}>
      <p data-testid="accessibility-updated">{t('updated', { date: updated })}</p>
      <LegalSection id="commitment" title={t('commitment.title')}>
        <p>{t('commitment.body')}</p>
      </LegalSection>
      <LegalSection id="status" title={t('status.title')}>
        <p>{t('status.body')}</p>
      </LegalSection>
      <LegalSection id="done" title={t('done.title')}>
        <ul>
          {DONE.map((k) => (
            <li key={k}>{t(`done.${k}`)}</li>
          ))}
        </ul>
      </LegalSection>
      <LegalSection id="limits" title={t('limits.title')}>
        <ul>
          {LIMITS.map((k) => (
            <li key={k}>{t.rich(`limits.${k}`, { ltr: (chunks) => <span className="ltr">{chunks}</span> })}</li>
          ))}
        </ul>
      </LegalSection>
      <LegalSection id="exemption" title={t('exemption.title')}>
        <p data-testid="accessibility-exemption">{t('exemption.body')}</p>
      </LegalSection>
      <LegalSection id="accessibility-contact" title={t('contact_title')}>
        <p>{t('contact')}</p>
        <ContactBlock phone={settings.business_phone} whatsapp={settings.business_whatsapp} headingId="accessibility-contact-block-heading" />
        <p>
          {t('email_label')}{' '}
          {settings.business_email ? (
            <a href={`mailto:${settings.business_email}`}>
              <span className="ltr">{settings.business_email}</span>
            </a>
          ) : (
            <span>{t('email_placeholder')}</span>
          )}
        </p>
      </LegalSection>
    </LegalPage>
  );
}
