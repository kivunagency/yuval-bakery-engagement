import 'server-only';
import { notFound } from 'next/navigation';
import { readFeatures } from '@/lib/server/features';

// Kept apart from lib/server/features.ts: that file is also loaded by the
// notification code outside Next (scheduled functions, tests), where
// next/navigation cannot load.

/** Customer account pages, routes and server actions call this first: 404 while accounts are off. */
export function requireCustomerAccounts(): void {
  if (!readFeatures().customerAccounts) notFound();
}
