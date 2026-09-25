import { getTranslations } from 'next-intl/server';

// Placeholder home until client-001 (catalog) lands.
export default async function HomePage() {
  const t = await getTranslations();
  return (
    <main id="main" className="page">
      <h1 className="display" data-testid="business-name">
        {t('business.details.name')}
      </h1>
      <p>{t('app.coming_soon')}</p>
    </main>
  );
}
