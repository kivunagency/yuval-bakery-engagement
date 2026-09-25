import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireAdminPage } from '@/lib/server/auth/admin';
import { signOutAction } from '@/app/(admin-auth)/admin/login/actions';
import { AdminTabs } from '@/components/admin/AdminTabs';
import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';
import '@/styles/admin.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Admin shell (db-005). getAdminSession() runs on every request that renders
// this layout; every page below ALSO calls requireAdminPage(), because Next.js
// does not re-render a layout on client navigation between its pages
// (tests/admin-pages-guarded.test.ts enforces that).
export default async function AdminShellLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  const t = await getTranslations();
  return (
    <ScopedIntlProvider scope="admin">
    <div className="admin-shell">
      <header className="admin-appbar">
        <p className="admin-brand">
          {t('admin.shell.title')}
          <small>{t('business.details.name')}</small>
        </p>
        <form action={signOutAction}>
          <button type="submit" className="admin-link-button" data-testid="admin-sign-out">
            {t('admin.shell.sign_out')}
          </button>
        </form>
      </header>
      <main id="main" className="admin-main">
        {children}
      </main>
      <AdminTabs />
    </div>
    </ScopedIntlProvider>
  );
}
