import { useTranslations } from 'next-intl';
import type { CatalogProduct } from '@/lib/shared/contracts/catalog';
import styles from '@/components/catalog/catalog.module.css';

// Product photo, or a neutral placeholder when Yuval has not uploaded one yet.
// The URL was built on the server (lib/server/catalog/photo-url.ts); alt text
// is Yuval's (photo_alt / alt_text), required before a product is published.
export function ProductPhoto({ photo, eager }: { photo: CatalogProduct['photos'][number] | undefined; eager: boolean }) {
  const t = useTranslations('catalog');
  if (!photo) {
    return (
      <div className={`${styles.ph} ${styles.placeholder}`} aria-hidden="true">
        <span>{t('photo_placeholder')}</span>
      </div>
    );
  }
  return (
    <div className={styles.ph}>
      {/* Storage serves the file directly (public bucket); there is no image optimizer on Netlify free. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.url} alt={photo.alt} loading={eager ? 'eager' : 'lazy'} decoding="async" width={800} height={800} />
    </div>
  );
}
