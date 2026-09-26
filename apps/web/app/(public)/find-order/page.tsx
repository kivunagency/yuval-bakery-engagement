import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FindOrderForm } from '@/components/find-order/FindOrderForm';
import styles from '@/components/find-order/find-order.module.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('find_order');
  return { title: t('meta_title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

// Find my order (US-0d, PRD). The form is the whole first frame (nothing to
// fetch before render); the result is what changes after it, so the form
// fetches POST /api/find-order. The result carries a capability link to the
// confirmation PDF, hence no-referrer and noindex (next.config.ts too).
export default async function FindOrderPage() {
  const t = await getTranslations('find_order');
  return (
    <main className="page" id="main">
      <header className={styles.header}>
        <Link href="/" className={styles.back} prefetch={false}>
          {t('back')}
        </Link>
        <h1>{t('title')}</h1>
        <p className={styles.intro}>{t('intro')}</p>
      </header>
      <FindOrderForm />
    </main>
  );
}
