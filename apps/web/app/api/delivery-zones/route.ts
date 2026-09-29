import { NextResponse } from 'next/server';
import { getPublicZones } from '@/lib/server/delivery/public-zones';

export const dynamic = 'force-dynamic';

// GET /api/delivery-zones (US-6). Active zones with their flat fee and cities
// (deliveryZonesResponse). Read-only; the checkout page gets the same data
// server-rendered. No PII.
export async function GET() {
  try {
    return NextResponse.json(await getPublicZones(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('delivery zones unavailable', e instanceof Error ? e.message : 'unknown');
    return NextResponse.json({ error: 'zones_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
