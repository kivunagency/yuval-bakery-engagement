import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import styles from './compliance.module.css';

// Privacy notice at the point of collection (Privacy Protection Law s.11,
// compliance-spec.md section 4). Place it BEFORE the first personal-data
// field: checkout (before the phone field), registration, custom-cake form
// (before the photo upload). A notice, not a consent: no checkbox.
// Names the business's courier (Yuval's uncle) as a recipient for deliveries.
// Checkout/registration record TEXT_VERSIONS.privacy as the version shown.
export type PrivacyNoticeContext = 'checkout' | 'registration' | 'custom_cake';

export function PrivacyNoticeAtCollection({ context, businessName, headingId = 'privacy-notice-heading' }: { context: PrivacyNoticeContext; businessName: string | null; headingId?: string }) {
  const t = useTranslations('privacy.notice');
  const tb = useTranslations('business');
  const name = businessName ?? tb('details.name');
  return (
    <section className={styles.privacyNotice} aria-labelledby={headingId} data-testid="privacy-notice-at-collection" data-context={context}>
      <h2 id={headingId} className={styles.noticeTitle}>
        {t('title')}
      </h2>
      <p>
        {t('collected_data', { businessName: name })} {t(`purpose_${context}`)}
      </p>
      <p>{t('recipients_uncle')}</p>
      {context === 'custom_cake' ? <p>{t('photos')}</p> : null}
      <p>
        {t('retention')}{' '}
        <Link className={styles.inlineLink} href="/privacy">
          {t('full_notice_link')}
        </Link>
      </p>
      <p className={styles.version}>
        {tb('version_label')} <span className="ltr">{TEXT_VERSIONS.privacy}</span>
      </p>
    </section>
  );
}

// Hint for free-text notes fields (compliance-spec.md section 4 item 9):
// render it under the field and link it with aria-describedby={id}.
export function NotesFieldHint({ id }: { id: string }) {
  const t = useTranslations('privacy');
  return (
    <p id={id} className={styles.hint} data-testid="notes-field-hint">
      {t('notes_hint')}
    </p>
  );
}
