import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { adminLoginStep } from '@/lib/server/auth/admin-login';
import { LoginForm } from '@/components/admin/LoginForm';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminLoginPage() {
  const step = await adminLoginStep();
  if (step === 'done') redirect('/admin');
  if (step === 'enrol') redirect('/admin/login/enroll');
  if (step === 'totp') redirect('/admin/login/verify');

  const t = await getTranslations('admin.login');
  return (
    <section className="admin-card" aria-labelledby="login-title">
      <h1 id="login-title">{t('title')}</h1>
      <p className="admin-lead">{t('intro')}</p>
      <LoginForm />
    </section>
  );
}
