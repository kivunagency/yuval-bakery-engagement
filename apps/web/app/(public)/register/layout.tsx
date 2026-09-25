import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';

// Adds the 'account' client message scope for this route's client components
// (i18n/client-namespaces.ts).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ScopedIntlProvider scope="account">{children}</ScopedIntlProvider>;
}
