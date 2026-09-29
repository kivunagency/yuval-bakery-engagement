import { useTranslations } from 'next-intl';

/** Placeholder for an admin screen another task will build. Visibly unfinished on purpose. */
export function ComingSoon({ title, children }: { title: string; children?: React.ReactNode }) {
  const t = useTranslations('admin.shell.placeholder');
  return (
    <section aria-labelledby="page-title" data-testid="coming-soon">
      <h1 id="page-title" className="admin-page-title">
        {title}
      </h1>
      <p className="admin-coming">
        <span className="admin-badge">{t('badge')}</span>
        {t('body')}
      </p>
      {children}
    </section>
  );
}
