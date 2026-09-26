// Netlify Scheduled Function, capacity-rollforward: once a day the weekly
// pattern is written into the next 60 days, so days keep opening without
// Yuval saving the pattern. 22:10 UTC = 00:10 (winter) or 01:10 (summer) in
// Jerusalem: always just after the Jerusalem midnight, so the window starts at
// the new day. Thin wrapper: the logic is lib/server/jobs/capacity-rollforward.ts.
import { runCapacityRollforward } from '@/lib/server/jobs/capacity-rollforward';
import { serviceClient } from '@/lib/server/supabase/service';

export default async function handler(): Promise<Response> {
  const outcome = await runCapacityRollforward(serviceClient());
  console.log(JSON.stringify(outcome));
  return Response.json(outcome, { status: outcome.ok ? 200 : 500 });
}

export const config = { schedule: '10 22 * * *' };
