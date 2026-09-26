import 'server-only';
import { NextResponse } from 'next/server';
import type { ProductsApiErrorBody } from '@/lib/shared/contracts/admin-products';

// Shared response helpers for the /api/admin/products routes (client-006).
// The routes themselves still call getAdminSession() and isSameOrigin() first,
// visibly (tests/admin-pages-guarded.test.ts checks every admin route file).

export const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const fail = (error: ProductsApiErrorBody['error'], status: number) => json({ error } satisfies ProductsApiErrorBody, status);

/** The JSON body, or undefined when it is not JSON (the route answers 400). */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
