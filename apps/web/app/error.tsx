'use client';

import { useTranslations } from 'next-intl';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('errors');
  return (
    <main id="main" className="page">
      <h1>{t('generic_title')}</h1>
      <button type="button" className="btn btn-secondary" onClick={reset}>
        {t('retry')}
      </button>
    </main>
  );
}
