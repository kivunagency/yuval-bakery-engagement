import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';
import { requireCustomerAccounts } from '@/lib/server/identity/accounts-gate';

// Adds the 'account' client message scope for this route's client components
// (i18n/client-namespaces.ts).
// 404 while customer accounts are off (lib/server/features/index.ts).
export default function Layout({ children }: { children: React.ReactNode }) {
  requireCustomerAccounts();
  return <ScopedIntlProvider scope="account">{children}</ScopedIntlProvider>;
}
