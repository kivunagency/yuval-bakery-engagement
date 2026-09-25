import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('errors');
  return (
    <main id="main" className="page">
      <h1>{t('not_found_title')}</h1>
      <p>{t('not_found_body')}</p>
      <Link className="btn btn-secondary" href="/">
        {t('back_home')}
      </Link>
    </main>
  );
}
