import { getTranslations } from 'next-intl/server';
import '@/styles/admin.css';

// Login, TOTP enrolment and TOTP verify screens: outside the admin shell (no
// tabs), since the user is not an aal2 admin yet.
export default async function AdminAuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="admin-auth">
      <header className="admin-appbar">
        <p className="admin-brand">
          {t('admin.shell.title')}
          <small>{t('business.details.name')}</small>
        </p>
      </header>
      <main id="main" className="admin-auth-main">
        {children}
      </main>
    </div>
  );
}
