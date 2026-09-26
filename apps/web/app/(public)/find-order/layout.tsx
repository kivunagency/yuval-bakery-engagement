import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';

// Adds the 'find_order' client message scope for this route's client components
// (i18n/client-namespaces.ts).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ScopedIntlProvider scope="find_order">{children}</ScopedIntlProvider>;
}
