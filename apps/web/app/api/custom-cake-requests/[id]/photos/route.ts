import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/server/http/origin';
import { finalizeCustomCakePhotos } from '@/lib/server/custom-cake/submit';
import { uuid } from '@/lib/shared/contracts/primitives';
import type { CustomCakeApiErrorBody, CustomCakePhotosResponse } from '@/lib/shared/contracts/custom-cake';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// POST /api/custom-cake-requests/[id]/photos (api-005, SEC-010): re-encode the
// files the browser uploaded to incoming/<id>/ and attach them to the request.
// The request id is a random UUID only the submitter received; the DB still
// refuses photos after the upload window, past 3, or on a reviewed request.
// Answers only counts, never paths.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(request)) return json({ error: 'invalid_input' } satisfies CustomCakeApiErrorBody, 403);
  const id = uuid.safeParse((await params).id);
  if (!id.success) return json({ error: 'not_found' } satisfies CustomCakeApiErrorBody, 404);
  try {
    const result = await finalizeCustomCakePhotos(id.data);
    return json(result satisfies CustomCakePhotosResponse, 200);
  } catch {
    console.error('custom cake photo processing unavailable');
    return json({ error: 'unavailable' } satisfies CustomCakeApiErrorBody, 503);
  }
}
