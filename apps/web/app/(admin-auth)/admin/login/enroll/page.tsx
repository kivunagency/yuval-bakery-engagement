import { Fragment } from 'react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { adminLoginStep, startTotpEnrolment } from '@/lib/server/auth/admin-login';
import { TotpForm } from '@/components/admin/TotpForm';
import { SignOutLink } from '../SignOutLink';

export const metadata: Metadata = { robots: { index: false, follow: false } };

// First-time TOTP enrolment (SEC-002): QR code plus the same key as text for
// typing into the app. The key is shown once, only to the signed-in admin at
// aal1 who has no verified factor yet.
export default async function AdminEnrolPage() {
  const step = await adminLoginStep();
  if (step === 'done') redirect('/admin');
  if (step === 'password') redirect('/admin/login');
  if (step === 'totp') redirect('/admin/login/verify');

  const enrolment = await startTotpEnrolment();
  if (!enrolment) redirect('/admin/login');

  const t = await getTranslations('admin.login');
  // Group the key in blocks of 4 for reading aloud or typing; the app ignores spaces.
  const groupedSecret = enrolment.secret.match(/.{1,4}/g)?.join(' ') ?? enrolment.secret;
  return (
    <section className="admin-card" aria-labelledby="enrol-title">
      <h1 id="enrol-title">{t('enrol_title')}</h1>
      <p className="admin-lead">{t('enrol_intro')}</p>
      <ol className="admin-steps">
        <li>{t('enrol_step_install')}</li>
        <li>{t('enrol_step_scan')}</li>
        <li>{t('enrol_step_code')}</li>
      </ol>
      {/* The QR is an SVG data URL from Supabase Auth; the CSP allows data: images. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="admin-qr" src={enrolment.qrCode} alt={t('enrol_qr_alt')} width={200} height={200} />
      <p className="admin-hint">{t('enrol_manual')}</p>
      <p className="admin-secret ltr num" data-testid="totp-secret">
        {groupedSecret.split(' ').map((group, i) => (
          <Fragment key={i}>
            {i > 0 ? ' ' : null}
            <span className="admin-secret-group">{group}</span>
          </Fragment>
        ))}
      </p>
      <p className="admin-hint">{t('enrol_reload_note')}</p>
      <TotpForm factorId={enrolment.factorId} submitLabel={t('enrol_submit')} />
      <SignOutLink />
    </section>
  );
}
