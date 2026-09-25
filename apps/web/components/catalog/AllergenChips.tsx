import { useTranslations } from 'next-intl';
import { isKnownAllergen } from '@/lib/shared/catalog/allergens';
import styles from '@/components/catalog/catalog.module.css';

// Allergens are always visible as chips, never in a tooltip or accordion
// (design-tokens.md "כרטיס מוצר", compliance-spec.md section 10). Solid chip =
// contains; dashed chip = may contain, with the full text inside it. A code
// outside the closed list is Yuval's own wording and is shown as she typed it.
export function AllergenChips({ contains, mayContain, notes }: { contains: string[]; mayContain: string[]; notes: string | null }) {
  const t = useTranslations('catalog');
  const label = (code: string) => (isKnownAllergen(code) ? t(`allergen.${code}`) : code);
  const none = contains.length === 0 && mayContain.length === 0;
  return (
    <>
      <ul className={styles.tags} aria-label={t('allergens_label')}>
        {contains.map((c) => (
          <li key={`c-${c}`} className={styles.tag}>
            {label(c)}
          </li>
        ))}
        {mayContain.map((c) => (
          <li key={`m-${c}`} className={`${styles.tag} ${styles.maybe}`}>
            {t('may_contain', { allergen: label(c) })}
          </li>
        ))}
        {none ? <li className={styles.tag}>{t('no_known_allergens')}</li> : null}
      </ul>
      {notes ? <p className={styles.allergenNotes}>{notes}</p> : null}
    </>
  );
}
