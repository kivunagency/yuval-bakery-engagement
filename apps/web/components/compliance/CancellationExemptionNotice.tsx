import { useTranslations } from 'next-intl';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import styles from './compliance.module.css';

// Cancellation-right exemption (Consumer Protection Law s.14C(d),
// compliance-spec.md section 9). Shown in full, never in an accordion, on the
// checkout summary before "continue to payment", in the order confirmation
// and on the cancellation policy page. kind picks the wording: a catalog
// product (perishable food) or a custom cake (made for this customer).
// The version shown is the version of this text; checkout records
// TEXT_VERSIONS.cancellation on the order.
export function CancellationExemptionNotice({ kind, headingId = 'cancellation-notice-heading' }: { kind: 'catalog' | 'custom_cake'; headingId?: string }) {
  const t = useTranslations('returns_policy.exemption_notice');
  return (
    <section className={styles.notice} aria-labelledby={headingId} data-testid="cancellation-exemption-notice" data-kind={kind}>
      <h2 id={headingId} className={styles.noticeTitle}>
        {t('title')}
      </h2>
      <p>{kind === 'custom_cake' ? t('custom_cake') : t('catalog')}</p>
      <p>{t('before_payment')}</p>
      <p>{t('defects')}</p>
      <p className={styles.version}>
        {t('version')} <span className="ltr">{TEXT_VERSIONS.cancellation}</span>
      </p>
    </section>
  );
}
