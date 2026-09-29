import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { PublicSiteSettings } from '@/lib/shared/contracts/site-settings';
import { ContactBlock } from '@/components/contact-block';
import styles from './SiteFooter.module.css';

// Footer on every public page: business name (s.14C; the osek number lives
// on /business and in the order confirmation, not in every footer), the
// contact block (US-0b) and links to the legal pages. Data comes from the
// public layout, fetched on the server.
export const FOOTER_LINKS = [
  { href: '/business', key: 'business' },
  { href: '/privacy', key: 'privacy' },
  { href: '/accessibility', key: 'accessibility' },
  { href: '/terms', key: 'terms' },
  { href: '/returns', key: 'returns' },
  { href: '/account', key: 'account' },
  { href: '/find-order', key: 'find_order' },
] as const;

// showAccount: false while customer accounts are off (lib/server/features/index.ts).
export function SiteFooter({ settings, showAccount }: { settings: PublicSiteSettings; showAccount: boolean }) {
  const t = useTranslations('footer');
  const tb = useTranslations('business');
  return (
    <footer className={styles.footer} data-testid="site-footer">
      <div className={styles.inner}>
        <p className={styles.name} data-testid="footer-business-name">
          {settings.business_name ?? tb('details.name')}
        </p>
        <ContactBlock phone={settings.business_phone} whatsapp={settings.business_whatsapp} headingId="footer-contact-heading" />
        <nav aria-label={t('nav_label')}>
          <ul className={styles.links}>
            {FOOTER_LINKS.filter((l) => showAccount || l.key !== 'account').map((l) => (
              <li key={l.href}>
                <Link href={l.href}>{t(`links.${l.key}`)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
