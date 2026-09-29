import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { pickNamespaces, type ClientScope } from '@/i18n/client-namespaces';

// Sends the browser only the message namespaces its client components use.
// Without this, every page would ship every string (the admin screens' text
// was reaching the public catalog). A nested provider replaces the messages
// of the one above it, so each scope lists everything it needs.
export async function ScopedIntlProvider({ scope, children }: { scope: ClientScope; children: React.ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={pickNamespaces(messages, scope)}>{children}</NextIntlClientProvider>;
}
