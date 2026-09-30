import { headers } from 'next/headers';
import { jsonLdScriptText } from '@/lib/shared/seo/json-ld';

// Inline structured data. The CSP is nonce-based with no 'unsafe-inline', so
// the script carries the per-request nonce from middleware (x-nonce). A
// JSON-LD block is data, not executed script, but the nonce keeps it valid
// under any stricter CSP reading.
export async function JsonLd({ data }: { data: Record<string, unknown> }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // React would entity-escape a text child and corrupt the JSON; the payload is
  // our own JSON.stringify output with `<` escaped (jsonLdScriptText), not user HTML.
  // eslint-disable-next-line react/no-danger
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLdScriptText(data) }} />;
}
