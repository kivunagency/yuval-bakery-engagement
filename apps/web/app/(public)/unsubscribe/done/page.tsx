import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import styles from '@/components/account/account.module.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

const RESULTS = ['done', 'invalid', 'unavailable'] as const;

export default async function UnsubscribeDonePage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const t = await getTranslations('account');
  const { result } = await searchParams;
  const r = RESULTS.find((x) => x === result) ?? 'invalid';
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1 data-testid="unsubscribe-result" data-result={r}>
        {t(`unsubscribe_${r}_title`)}
      </h1>
      <p className={r === 'done' ? styles.lead : styles.error}>{t(`unsubscribe_${r}_body`)}</p>
    </main>
  );
}
