// Netlify Scheduled Function, daily retention (compliance-spec.md section 3,
// SEC-028). 00:40 UTC = 02:40 or 03:40 in Jerusalem, outside working hours.
// Thin wrapper: the logic is lib/server/jobs/retention.ts.
import { runRetention } from '@/lib/server/jobs/retention';
import { serviceClient } from '@/lib/server/supabase/service';

export default async function handler(): Promise<Response> {
  const outcome = await runRetention(serviceClient());
  console.log(JSON.stringify(outcome));
  return Response.json(outcome, { status: outcome.ok ? 200 : 500 });
}

export const config = { schedule: '40 0 * * *' };
