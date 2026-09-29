import { getTranslations } from 'next-intl/server';
import '@/styles/admin.css';
import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';

// Login, TOTP enrolment and TOTP verify screens: outside the admin shell (no
// tabs), since the user is not an aal2 admin yet.
export default async function AdminAuthLayout({ children }: { children: React.ReactNode }) {
  const [t, site] = await Promise.all([getTranslations(), getPublicSiteSettings()]);
  return (
    <ScopedIntlProvider scope="admin">
    <div className="admin-auth">
      <header className="admin-appbar">
        <p className="admin-brand">
          {t('admin.shell.title')}
          <small>{site.business_name ?? t('business.details.name')}</small>
        </p>
      </header>
      <main id="main" className="admin-auth-main">
        {children}
      </main>
    </div>
    </ScopedIntlProvider>
  );
}
