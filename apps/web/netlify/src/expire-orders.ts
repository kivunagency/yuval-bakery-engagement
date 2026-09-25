// Netlify Scheduled Function, job-001 (ADR-001): every 15 minutes, UTC cron.
// Thin wrapper: the logic is lib/server/jobs/expire-orders.ts (tested without
// Netlify against the local stack). Built by scripts/build-functions.mjs into
// netlify/functions/expire-orders.mjs. "Scheduled functions have no public URL
// in production" is UNVERIFIED (docs.netlify.com unreachable from the build
// session); if one exists, calling it only runs an idempotent sweep (SEC-007).
import { runExpirySweep } from '@/lib/server/jobs/expire-orders';
import { serviceClient } from '@/lib/server/supabase/service';

export default async function handler(): Promise<Response> {
  const outcome = await runExpirySweep(serviceClient());
  console.log(JSON.stringify(outcome));
  return Response.json(outcome, { status: outcome.ok ? 200 : 500 });
}

export const config = { schedule: '*/15 * * * *' };
