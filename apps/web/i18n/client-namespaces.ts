import type { AbstractIntlMessages } from 'next-intl';

// Top-level message namespaces each client scope may receive. Only what the
// client components of that part of the site use: a public page never ships
// the admin's strings, and the catalog never ships checkout or account text.
// A route whose client components need more wraps itself in
// <ScopedIntlProvider scope="..."> (see app/(public)/*/layout.tsx).
// tests/client-namespaces.test.ts checks components against these lists.
const CORE = ['errors', 'catalog', 'day_state', 'business', 'returns_policy', 'privacy', 'contact', 'footer'] as const;

export const CLIENT_SCOPES = {
  public: CORE,
  checkout: [...CORE, 'checkout'],
  order: [...CORE, 'payment'],
  find_order: [...CORE, 'find_order'],
  custom_cake: [...CORE, 'custom_cake'],
  account: [...CORE, 'registration', 'account'],
  admin: [...CORE, 'admin', 'push', 'confirmation'],
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
