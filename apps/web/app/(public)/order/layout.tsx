import { ScopedIntlProvider } from '@/components/i18n/ScopedIntlProvider';

// Adds the 'order' client message scope for this route's client components
// (i18n/client-namespaces.ts).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ScopedIntlProvider scope="order">{children}</ScopedIntlProvider>;
}
