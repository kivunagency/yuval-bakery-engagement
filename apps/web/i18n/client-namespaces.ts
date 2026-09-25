import type { AbstractIntlMessages } from 'next-intl';

// Top-level message namespaces each client scope may receive. A client
// component that calls useTranslations('<ns>') must have <ns> listed for every
// scope it renders in (tests/client-namespaces.test.ts checks this).
const PUBLIC = ['errors', 'catalog', 'day_state', 'business', 'returns_policy', 'privacy', 'contact', 'footer', 'checkout'] as const;

export const CLIENT_SCOPES = {
  public: PUBLIC,
  admin: [...PUBLIC, 'admin'],
} as const;

export type ClientScope = keyof typeof CLIENT_SCOPES;

export function pickNamespaces(messages: AbstractIntlMessages, scope: ClientScope): AbstractIntlMessages {
  const out: AbstractIntlMessages = {};
  for (const ns of CLIENT_SCOPES[scope]) {
    const value = messages[ns];
    if (value !== undefined) out[ns] = value;
  }
  return out;
}
