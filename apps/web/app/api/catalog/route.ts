import { NextResponse } from 'next/server';
import { CatalogUnavailableError, getCatalog } from '@/lib/server/catalog/get-catalog';

export const dynamic = 'force-dynamic';

// GET /api/catalog (api-001). Contract: lib/shared/contracts/catalog.ts.
// Public, no auth. A DB failure answers 503 with a code, never DB text.
export async function GET() {
  try {
    const body = await getCatalog();
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof CatalogUnavailableError) {
      console.error('catalog unavailable', e.message);
      return NextResponse.json({ error: 'catalog_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    throw e;
  }
}
