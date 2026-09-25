import { SiteFooter } from '@/components/site-footer';
import { getPublicSiteSettings } from '@/lib/server/compliance/site-settings';

// Public pages: page content, then the site footer (business details s.14C,
// contact block US-0b, legal links). Settings are read on the server.
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const settings = await getPublicSiteSettings();
  return (
    <>
      {children}
      <SiteFooter settings={settings} />
    </>
  );
}
