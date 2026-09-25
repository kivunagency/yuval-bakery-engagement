import { useTranslations } from 'next-intl';
import styles from './LegalPage.module.css';

// Frame for the legal pages (/business, /privacy, /accessibility, /terms,
// /returns): title, a visible "draft pending legal review" line until a
// lawyer has read the text, and the version of the text this page renders.
export function LegalPage({ title, version, children }: { title: string; version?: string; children: React.ReactNode }) {
  const t = useTranslations('business');
  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{title}</h1>
      <p className={styles.draft} data-testid="legal-draft-notice">
        {t('legal_draft_notice')}
      </p>
      {version ? (
        <p className={styles.version} data-testid="legal-version">
          {t('version_label')} <span className="ltr">{version}</span>
        </p>
      ) : null}
      {children}
    </main>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-heading`} id={id}>
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </section>
  );
}
