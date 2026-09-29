import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BusinessDetails, PrivacyNoticeAtCollection } from '@/components/compliance';
import { LegalPage, LegalSection } from '@/components/legal-page';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('privacy.page');
  return { title: t('title') };
}

// compliance-001: the full privacy notice (Privacy Protection Law s.11,
// compliance-spec.md section 4), plus the cookies statement (section 7).
// Retention periods come from app_settings, so the page never promises a
// period the retention job does not apply.
const COLLECTED = ['name', 'phone', 'address', 'email', 'notes', 'inscription', 'photos', 'profile_dates'] as const;
const NOT_COLLECTED = ['birth_year', 'id_number', 'payment', 'location'] as const;
const PURPOSES = ['order', 'delivery', 'account', 'marketing'] as const;
const RECIPIENTS = ['courier', 'hosting', 'email', 'whatsapp', 'receipts'] as const;
const RIGHTS = ['access', 'correction', 'marketing', 'registered'] as const;

export default async function PrivacyPage() {
  const [t, settings] = await Promise.all([getTranslations('privacy.page'), getPublicSiteSettings()]);
  const unset = t('unset_number');
  const n = (v: number | null) => (v === null ? unset : String(v));
  const list = (group: string, keys: readonly string[]) => (
    <ul>
      {keys.map((k) => (
        <li key={k}>{t(`${group}.${k}`)}</li>
      ))}
    </ul>
  );

  return (
    <LegalPage title={t('title')} version={TEXT_VERSIONS.privacy}>
      <p>{t('intro')}</p>
      <PrivacyNoticeAtCollection context="checkout" businessName={settings.business_name} headingId="privacy-summary-heading" />
      <LegalSection id="owner" title={t('owner.title')}>
        <p>{t('owner.body')}</p>
        <BusinessDetails settings={settings} variant="full" />
      </LegalSection>
      <LegalSection id="collected" title={t('collected.title')}>
        {list('collected', COLLECTED)}
        <p>{t('not_collected.title')}</p>
        {list('not_collected', NOT_COLLECTED)}
      </LegalSection>
      <LegalSection id="obligation" title={t('obligation.title')}>
        <p>{t('obligation.body')}</p>
      </LegalSection>
      <LegalSection id="purposes" title={t('purposes.title')}>
        {list('purposes', PURPOSES)}
      </LegalSection>
      <LegalSection id="recipients" title={t('recipients.title')}>
        {list('recipients', RECIPIENTS)}
      </LegalSection>
      <LegalSection id="abroad" title={t('abroad.title')}>
        <p>{t('abroad.body')}</p>
      </LegalSection>
      <LegalSection id="retention" title={t('retention.title')}>
        <ul>
          <li data-testid="retention-orders">{t('retention.orders', { months: n(settings.guest_pii_months) })}</li>
          <li>{t('retention.financial')}</li>
          <li data-testid="retention-photos">{t('retention.photos', { days: n(settings.photo_retention_days) })}</li>
          <li data-testid="retention-profile">{t('retention.profile', { months: n(settings.inactive_profile_months) })}</li>
          <li>{t('retention.consent')}</li>
        </ul>
        <p>{t('retention.pending')}</p>
      </LegalSection>
      <LegalSection id="rights" title={t('rights.title')}>
        {list('rights', RIGHTS)}
      </LegalSection>
      <LegalSection id="photos" title={t('photos.title')}>
        <p>{t('photos.body', { days: n(settings.photo_retention_days) })}</p>
      </LegalSection>
      <LegalSection id="health" title={t('health.title')}>
        <p>{t('health.body')}</p>
      </LegalSection>
      <LegalSection id="cookies" title={t('cookies.title')}>
        <p>{t('cookies.body')}</p>
      </LegalSection>
    </LegalPage>
  );
}
