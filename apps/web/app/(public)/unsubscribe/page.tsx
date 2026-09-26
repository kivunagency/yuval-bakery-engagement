import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { unsubscribeToken } from '@/lib/shared/contracts/registration';
import styles from '@/components/account/account.module.css';

// qa-006/compliance-005: every page has a title of its own (WCAG 2.4.2)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account');
  return { title: t('unsubscribe_title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

// One-click unsubscribe (compliance-spec section 5): the link in a marketing
// mail opens this page; one button, no sign-in. GET changes nothing (mail
// scanners open links); the button POSTs to /api/unsubscribe. Plain HTML
// form, works without JavaScript.
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const t = await getTranslations('account');
  const { token } = await searchParams;
  const valid = unsubscribeToken.safeParse(token).success;
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{t('unsubscribe_title')}</h1>
      {valid ? (
        <>
          <p className={styles.lead}>{t('unsubscribe_body')}</p>
          <form method="post" action="/api/unsubscribe" data-testid="unsubscribe-form">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className={`btn btn-primary ${styles.submit}`}>
              {t('unsubscribe_button')}
            </button>
          </form>
        </>
      ) : (
        <p className={styles.error} role="status" data-testid="unsubscribe-missing">
          {t('unsubscribe_missing')}
        </p>
      )}
    </main>
  );
}
