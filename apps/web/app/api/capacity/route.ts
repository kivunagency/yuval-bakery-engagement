import { NextResponse, type NextRequest } from 'next/server';
import { capacityQuery, DEFAULT_DAY_RANGE } from '@/lib/shared/contracts/capacity';
import { defaultDayWindow, getDayAvailability } from '@/lib/server/capacity/day-availability';
import { DbError } from '@/lib/server/supabase/rpc';
import { addDays } from '@/lib/shared/time/jerusalem';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// GET /api/capacity (api-002). Query: ?date=YYYY-MM-DD for one day, or
// ?from=&to= for a range (at most 63 days, checked by the DB), or nothing for
// the next 14 days from today in Asia/Jerusalem. Contract:
// lib/shared/contracts/capacity.ts. States only, never minutes.
export async function GET(request: NextRequest) {
  const parsed = capacityQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400, headers: NO_STORE });
  }
  const q = parsed.data;
  const fallback = defaultDayWindow();
  const from = q.date ?? q.from ?? fallback.from;
  const to = q.date ?? q.to ?? (q.from ? addDays(q.from, DEFAULT_DAY_RANGE - 1) : fallback.to);

  try {
    const body = await getDayAvailability(from, to);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof DbError && e.code === 'day_range_invalid') {
      return NextResponse.json({ error: 'day_range_invalid' }, { status: 400, headers: NO_STORE });
    }
    if (e instanceof DbError) {
      console.error('capacity unavailable', e.raw);
      return NextResponse.json({ error: 'capacity_unavailable' }, { status: 503, headers: NO_STORE });
    }
    throw e;
  }
}
