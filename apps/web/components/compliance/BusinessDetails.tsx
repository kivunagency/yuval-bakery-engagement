import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { PublicSiteSettings } from '@/lib/shared/contracts/site-settings';
import { displayPhone, telHref } from '@/lib/shared/contact/links';
import styles from './compliance.module.css';

// Business details under Consumer Protection Law s.14C. "full" is the
// /business page; "summary" is for the checkout summary before payment and
// the order confirmation (name, osek, contact, link to the full page).
// Every unset value renders as a visible placeholder, e.g. [business name].
export function BusinessDetails({ settings, variant }: { settings: PublicSiteSettings; variant: 'full' | 'summary' }) {
  const t = useTranslations('business');
  const s = settings;
  const regStatus = s.vat_status === 'licensed' ? t('status.licensed') : s.vat_status === 'exempt' ? t('status.exempt') : null;
  const tel = telHref(s.business_phone);
  const phone = displayPhone(s.business_phone);

  const Row = ({ label, children, id }: { label: string; children: React.ReactNode; id: string }) => (
    <div className={styles.row} data-testid={`business-${id}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
  const Placeholder = ({ text }: { text: string }) => <span className={styles.placeholder}>{text}</span>;

  return (
    <dl className={styles.details} data-testid={`business-details-${variant}`}>
      <Row id="name" label={t('labels.name')}>
        {s.business_name ?? <Placeholder text={t('details.name')} />}
      </Row>
      {variant === 'full' ? (
        <Row id="owner" label={t('labels.owner_name')}>
          {s.business_owner_name ?? <Placeholder text={t('details.owner_name')} />}
        </Row>
      ) : null}
      <Row id="registration" label={t('labels.registration')}>
        {s.business_registration_number && regStatus ? (
          <>
            {regStatus} <span className="ltr num">{s.business_registration_number}</span>
          </>
        ) : (
          <Placeholder text={t('details.registration_number')} />
        )}
      </Row>
      {variant === 'full' ? (
        <Row id="address" label={t('labels.address')}>
          {s.business_address ?? <Placeholder text={t('details.address')} />}
        </Row>
      ) : null}
      <Row id="phone" label={t('labels.phone')}>
        {tel && phone ? (
          <a className={styles.inlineLink} href={tel}>
            <span className="ltr num">{phone}</span>
          </a>
        ) : (
          <Placeholder text={t('details.phone')} />
        )}
      </Row>
      <Row id="email" label={t('labels.email')}>
        {s.business_email ? (
          <a className={styles.inlineLink} href={`mailto:${s.business_email}`}>
            <span className="ltr">{s.business_email}</span>
          </a>
        ) : (
          <Placeholder text={t('details.email')} />
        )}
      </Row>
      {variant === 'summary' ? (
        <div className={styles.row}>
          <dd>
            <Link className={styles.inlineLink} href="/business">
              {t('all_details_link')}
            </Link>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
