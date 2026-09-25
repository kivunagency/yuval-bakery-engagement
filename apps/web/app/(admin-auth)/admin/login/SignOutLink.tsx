import { getTranslations } from 'next-intl/server';
import { signOutAction } from './actions';

/** Leaves a half-finished login (aal1 session) and returns to the password screen. */
export async function SignOutLink() {
  const t = await getTranslations('admin.login');
  return (
    <form action={signOutAction} className="admin-signout-inline">
      <button type="submit" className="admin-link-button">
        {t('other_account')}
      </button>
    </form>
  );
}
