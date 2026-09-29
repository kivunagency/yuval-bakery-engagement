import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { createUserClient } from '@/lib/server/supabase/server';
import { loadPendingQueue } from '@/lib/server/custom-cake/queue';
import { CustomCakeRequestCard } from '@/components/admin/custom-cake/CustomCakeRequestCard';

export const dynamic = 'force-dynamic';

// Custom-cake requests waiting for Yuval (client-008, PRD US-2), under the
// Orders tab. Arrives with its data: the pending requests and their photos'
// signed URLs are read on the server. Only the live capacity answer, approve
// and decline go through fetch. Inspiration photos are never promoted to the
// catalog: there is no such action (Ran, 2026-09-25).
export default async function AdminCustomCakesPage() {
  await requireAdminPage();
  const t = await getTranslations('admin.custom_cake');
  const queue = await loadPendingQueue(await createUserClient());
  return (
    <>
      <h1 className="admin-page-title">{t('queue_title')}</h1>
      {queue.length === 0 ? (
        <p className="admin-lead" data-testid="custom-cake-empty">
          {t('empty')}
        </p>
      ) : (
        <>
          <p className="admin-lead">{t('count', { count: queue.length })}</p>
          <ul className="admin-cc-list">
            {queue.map((item) => (
              <li key={item.id}>
                <CustomCakeRequestCard item={item} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
