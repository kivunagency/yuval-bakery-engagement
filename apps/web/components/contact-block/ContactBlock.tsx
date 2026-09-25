import { useTranslations } from 'next-intl';
import { displayPhone, telHref, waMeHref } from '@/lib/shared/contact/links';
import styles from './ContactBlock.module.css';

// US-0b: Yuval's phone (tap to call) and a direct WhatsApp link, on every
// page (the site footer renders it). A page about one order renders its own
// copy with orderNumber, so the WhatsApp message arrives prefilled with it.
// While a number is not set (or not a valid Israeli number) the block shows
// a visible placeholder, never a link to a guessed number.
export type ContactBlockProps = {
  phone: string | null;
  whatsapp: string | null;
  orderNumber?: string;
  headingId?: string;
};

export function ContactBlock({ phone, whatsapp, orderNumber, headingId = 'contact-heading' }: ContactBlockProps) {
  const t = useTranslations('contact');
  const tel = telHref(phone);
  const shown = displayPhone(phone);
  const wa = waMeHref(whatsapp, orderNumber ? t('whatsapp_prefill_order', { orderNumber }) : undefined);

  return (
    <section className={styles.block} aria-labelledby={headingId} data-testid="contact-block">
      <h2 id={headingId} className={styles.heading}>
        {t('title')}
      </h2>
      {orderNumber ? (
        <p className={styles.order}>
          {t('about_order')} <span className="ltr num">{orderNumber}</span>
        </p>
      ) : null}
      <div className={styles.actions}>
        {tel && shown ? (
          <a className={`btn btn-secondary ${styles.action}`} href={tel} data-testid="contact-call">
            <span>{t('call')}</span> <span className="ltr num">{shown}</span>
          </a>
        ) : (
          <p className={styles.placeholder} data-testid="contact-call-placeholder">
            {t('call')}: {t('phone_placeholder')}
          </p>
        )}
        {wa ? (
          <a className={`btn btn-secondary ${styles.action}`} href={wa} rel="noopener noreferrer" data-testid="contact-whatsapp">
            {t('whatsapp')}
          </a>
        ) : (
          <p className={styles.placeholder} data-testid="contact-whatsapp-placeholder">
            {t('whatsapp')}: {t('whatsapp_placeholder')}
          </p>
        )}
      </div>
    </section>
  );
}
