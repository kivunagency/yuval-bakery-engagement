import Link from 'next/link';

export type SettingsNavItem = { href: string; title: string; status: string; attention: boolean; testId: string };

// The sections of the Settings tab that have their own screen. Each link
// says in words whether something there still needs Yuval (for example
// details that show a placeholder on the site). Server-rendered.
export function SettingsNav({ label, items }: { label: string; items: SettingsNavItem[] }) {
  return (
    <nav aria-label={label}>
      <ul className="admin-settings-nav">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} prefetch={false} data-testid={item.testId} data-attention={item.attention || undefined}>
              <span className="admin-settings-nav-title">{item.title}</span>
              <span className="admin-settings-nav-status">{item.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
