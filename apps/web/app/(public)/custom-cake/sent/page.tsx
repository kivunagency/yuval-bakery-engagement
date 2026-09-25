import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import styles from '@/components/custom-cake/custom-cake.module.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('custom_cake');
  return { title: t('submitted_confirmation'), robots: { index: false } };
}

// Confirmation after a custom-cake request (client-002). Carries no personal
// data and no request id: the URL says only whether the photos made it. A
// request is not an order: no number, no payment, no day held (PRD US-2).
// The site footer below carries the WhatsApp link the photo note points to.
export default async function CustomCakeSentPage({ searchParams }: { searchParams: Promise<{ photos?: string }> }) {
  const [t, params] = await Promise.all([getTranslations('custom_cake'), searchParams]);
  const photos = params.photos === 'unavailable' || params.photos === 'partial' ? params.photos : null;
  return (
    <main className="page" id="main">
      <div className={styles.sent}>
        <section className={styles.status} role="status" aria-labelledby="sent-title">
          <h1 id="sent-title">{t('submitted_confirmation')}</h1>
          <p>{t('sent.body')}</p>
        </section>
        {photos ? <p className={styles.photoNote}>{t(`sent.photos_${photos}`)}</p> : null}
        <section aria-labelledby="sent-next">
          <h2 id="sent-next">{t('sent.steps_title')}</h2>
          <ol className={styles.steps}>
            <li>{t('sent.step_review')}</li>
            <li>{t('sent.step_price')}</li>
            <li>{t('sent.step_hold')}</li>
          </ol>
        </section>
        <Link href="/" className="btn btn-secondary" prefetch={false}>
          {t('sent.back')}
        </Link>
      </div>
    </main>
  );
}
