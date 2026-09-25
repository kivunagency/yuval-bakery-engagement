import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { loadMyAccount } from '@/lib/server/identity/account';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';
import { PreferencesForm } from '@/components/account/PreferencesForm';
import { ProfileForm } from '@/components/account/ProfileForm';
import { monthNames } from '@/components/account/month-names';
import { ContactBlock } from '@/components/contact-block';
import { Price } from '@/components/price/Price';
import { displayPhone } from '@/lib/shared/contact/links';
import { signOutAction } from './actions';
import styles from '@/components/account/account.module.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

const ORDER_STATUSES = ['payment_pending', 'paid', 'fulfilled', 'expired', 'cancelled'] as const;
const CONSENT_SOURCES = ['registration', 'profile', 'unsubscribe_link', 'admin_on_request', 'account_deletion'] as const;

// client-005: the account page. Arrives with its data (server render). Shows
// everything stored about the customer (s.13 access), lets them correct name
// and phone (s.14), and change the s.30A choice. Copy/deletion: on request
// to the business (compliance-spec section 6; self-service deletion is not
// required by Israeli law and is not built).
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const account = await loadMyAccount();
  if (!account) redirect('/account/login');
  if (!account.profile) redirect('/account/complete');
  const p = account.profile;
  const t = await getTranslations('account');
  const tb = await getTranslations('business');
  const format = await getFormatter();
  const settings = await getPublicSiteSettings();
  const months = monthNames(await getLocale());
  const { saved } = await searchParams;

  const date = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Asia/Jerusalem' }) : t('not_set'));
  const dayMonth = (day: number | null, month: number | null) => (day && month ? t('day_month', { day, month: months[month - 1] ?? '' }) : t('not_set'));
  const statusLabel = (s: string) => (ORDER_STATUSES.find((x) => x === s) ? t(`status.${s as (typeof ORDER_STATUSES)[number]}`) : s);
  const sourceLabel = (s: string) => (CONSENT_SOURCES.find((x) => x === s) ? t(`consent_source.${s as (typeof CONSENT_SOURCES)[number]}`) : s);

  return (
    <main id="main" className={`page ${styles.page}`}>
      <h1>{t('title')}</h1>
      <p className={styles.lead}>{t.rich('signed_in_as', { email: account.session.email, addr: (c) => <bdi dir="ltr">{c}</bdi> })}</p>
      {saved === 'preferences' ? (
        <p className={styles.ok} role="status">
          {t('saved')}
        </p>
      ) : null}

      <section className={styles.card} aria-labelledby="details-title" data-testid="account-details">
        <h2 id="details-title">{t('details_title')}</h2>
        <p className={styles.hint}>{t('details_intro')}</p>
        <dl className={styles.details}>
          <div className={styles.row}>
            <dt>{t('name')}</dt>
            <dd>{p.name ?? t('not_set')}</dd>
          </div>
          <div className={styles.row}>
            <dt>{t('phone')}</dt>
            <dd>
              <bdi dir="ltr" className="num">{displayPhone(p.phone) ?? p.phone}</bdi>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>{t('email')}</dt>
            <dd>
              <bdi dir="ltr">{p.email ?? account.session.email}</bdi>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>{t('birthday')}</dt>
            <dd data-testid="detail-birthday">{dayMonth(p.birthday_day, p.birthday_month)}</dd>
          </div>
          <div className={styles.row}>
            <dt>{t('anniversary')}</dt>
            <dd data-testid="detail-anniversary">{dayMonth(p.anniversary_day, p.anniversary_month)}</dd>
          </div>
          <div className={styles.row}>
            <dt>{t('marketing')}</dt>
            <dd data-testid="detail-marketing">{p.marketing_opt_in ? t('marketing_on', { date: date(p.marketing_opt_in_at) }) : t('marketing_off')}</dd>
          </div>
          <div className={styles.row}>
            <dt>{t('age_confirmed')}</dt>
            <dd>{date(p.age_confirmed_18_at)}</dd>
          </div>
          <div className={styles.row}>
            <dt>{t('privacy_version')}</dt>
            <dd>
              <span className="ltr">{p.privacy_notice_version ?? t('not_set')}</span>
            </dd>
          </div>
          <div className={styles.row}>
            <dt>{t('created')}</dt>
            <dd>{date(p.created_at)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.card} aria-labelledby="edit-title">
        <h2 id="edit-title">{t('edit_title')}</h2>
        <ProfileForm name={p.name ?? ''} phone={displayPhone(p.phone) ?? p.phone} />
      </section>

      <section className={styles.card} aria-labelledby="prefs-title">
        <h2 id="prefs-title">{t('preferences_title')}</h2>
        <PreferencesForm
          source="profile"
          businessName={settings.business_name ?? tb('details.name')}
          optedIn={p.marketing_opt_in}
          birthday={{ day: p.birthday_day, month: p.birthday_month }}
          anniversary={{ day: p.anniversary_day, month: p.anniversary_month }}
          monthNames={months}
        />
        <h3>{t('consent_history_title')}</h3>
        {account.consentEvents.length === 0 ? (
          <p className={styles.hint}>{t('no_consent_events')}</p>
        ) : (
          <ul className={styles.list} data-testid="consent-history">
            {account.consentEvents.map((e) => (
              <li key={`${e.created_at}-${e.action}`}>
                <span>
                  {e.action === 'granted' ? t('consent_granted') : t('consent_withdrawn')}, {sourceLabel(e.source)}
                </span>
                <span className={styles.muted}>{date(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card} aria-labelledby="orders-title">
        <h2 id="orders-title">{t('orders_title')}</h2>
        {account.orders.length === 0 ? (
          <p className={styles.hint} data-testid="orders-empty">
            {t('orders_empty')}
          </p>
        ) : (
          <ul className={styles.list} data-testid="orders-list">
            {account.orders.map((o) => (
              <li key={o.order_number}>
                <span>
                  {t('order_number')} <span className="ltr num">{o.order_number}</span>, {date(o.delivery_date)}
                </span>
                <span>
                  {statusLabel(o.status)}, <Price amount={o.total_displayed} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card} aria-labelledby="rights-title">
        <h2 id="rights-title">{t('rights_title')}</h2>
        <p className={styles.lead}>{t('rights_body')}</p>
        <ContactBlock phone={settings.business_phone} whatsapp={settings.business_whatsapp} headingId="account-contact-heading" />
      </section>

      <form action={signOutAction}>
        <button type="submit" className={`btn btn-secondary ${styles.submit}`} data-testid="sign-out">
          {t('sign_out')}
        </button>
      </form>
    </main>
  );
}
