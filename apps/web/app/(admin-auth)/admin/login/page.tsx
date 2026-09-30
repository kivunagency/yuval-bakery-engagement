import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { adminLoginStep } from '@/lib/server/auth/admin-login';
import { LoginForm } from '@/components/admin/LoginForm';
import { IDLE_REASON } from '@/lib/shared/auth/session-policy';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminLoginPage({ searchParams }: { searchParams: Promise<{ reason?: string | string[] }> }) {
  const [{ reason }, step] = await Promise.all([searchParams, adminLoginStep()]);
  if (step === 'done') redirect('/admin');
  if (step === 'enrol') redirect('/admin/login/enroll');
  if (step === 'totp') redirect('/admin/login/verify');

  const t = await getTranslations('admin.login');
  return (
    <section className="admin-card" aria-labelledby="login-title">
      <h1 id="login-title">{t('title')}</h1>
      <p className="admin-lead">{t('intro')}</p>
      {reason === IDLE_REASON ? (
        <p className="admin-form-error" role="alert" data-testid="idle-notice">
          {t('idle_notice')}
        </p>
      ) : null}
      <LoginForm />
    </section>
  );
}
