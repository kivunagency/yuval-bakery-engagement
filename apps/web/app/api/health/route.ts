import { NextResponse } from 'next/server';
import { healthResponse } from '@/lib/shared/contracts/health';
import { checkDatabase } from '@/lib/server/health';

export const dynamic = 'force-dynamic';

// Liveness + DB reachability. Also the fallback keep-alive target for the
// Supabase free-tier pause (ADR-001). Reveals nothing but up/down.
export async function GET() {
  const db = await checkDatabase();
  const body = healthResponse.parse({ status: db === 'up' ? 'ok' : 'degraded', db });
  return NextResponse.json(body, { status: db === 'up' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
