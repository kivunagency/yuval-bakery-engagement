'use client';

import type { useTranslations } from 'next-intl';
import type { AdminProduct, ProductsApiErrorBody } from '@/lib/shared/contracts/admin-products';

// Browser side of /api/admin/products (client-006). Every call answers either
// the product as the DB now has it, or a sentence for the screen.

export type Translate = ReturnType<typeof useTranslations<'admin.products'>>;
export type ApiResult = { product?: AdminProduct; error?: string };

export async function errorText(t: Translate, res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as ProductsApiErrorBody | null;
  switch (body?.error) {
    case 'invalid_input':
      return t('error_invalid');
    case 'not_found':
      return t('error_not_found');
    case 'allergens_not_confirmed':
      return t('error_allergens_not_confirmed');
    case 'photo_alt_required':
      return t('error_photo_alt_required');
    case 'photo_limit_reached':
      return t('photo_limit');
    case 'photo_rejected':
      return t('error_photo_rejected');
    case 'upload_missing':
      return t('error_upload');
    case 'unauthorized':
      return t('error_session');
    default:
      return t('error_generic');
  }
}

/** One JSON request; DELETE of a product answers no product. */
export async function send(t: Translate, url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) return { error: await errorText(t, res) };
    const json = (await res.json()) as unknown;
    return json && typeof json === 'object' && 'id' in json ? { product: json as AdminProduct } : {};
  } catch {
    return { error: t('error_generic') };
  }
}

