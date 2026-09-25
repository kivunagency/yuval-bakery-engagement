import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { adminLoginStep } from '@/lib/server/auth/admin-login';
import { TotpForm } from '@/components/admin/TotpForm';
import { SignOutLink } from '../SignOutLink';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminVerifyPage() {
  const step = await adminLoginStep();
  if (step === 'done') redirect('/admin');
  if (step === 'password') redirect('/admin/login');
  if (step === 'enrol') redirect('/admin/login/enroll');

  const t = await getTranslations('admin.login');
  return (
    <section className="admin-card" aria-labelledby="verify-title">
      <h1 id="verify-title">{t('verify_title')}</h1>
      <p className="admin-lead">{t('verify_intro')}</p>
      <TotpForm submitLabel={t('verify_submit')} />
      <p className="admin-hint">{t('lost_phone')}</p>
      <SignOutLink />
    </section>
  );
}
