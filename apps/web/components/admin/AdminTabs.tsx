'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

// Bottom navigation of the admin (design-tokens.md "ניהול"): 4 text tabs,
// 56px high, the active one marked by a 3px accent bar. Custom-cake requests
// live under the Orders tab (the design has exactly four tabs).
const TABS = [
  { key: 'orders', href: '/admin/orders', also: ['/admin/custom-cakes'] },
  { key: 'capacity', href: '/admin/capacity', also: [] },
  { key: 'catalog', href: '/admin/catalog', also: [] },
  { key: 'settings', href: '/admin/settings', also: [] },
] as const;

export function AdminTabs() {
  const t = useTranslations('admin.shell');
  const pathname = usePathname();
  const isActive = (href: string, also: readonly string[]) =>
    [href, ...also].some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <nav className="admin-tabs" aria-label={t('nav_label')}>
      {TABS.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={isActive(tab.href, tab.also) ? 'page' : undefined} prefetch={false}>
          {t(`tabs.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}
