-- Migration: 20260926150300_capacity_rollforward_heartbeat
-- Task: capacity-rollforward (wave 3, session N). Lane: 20260926150000..159999.
--
-- The daily Netlify function netlify/src/capacity-rollforward.ts calls
-- fn_materialize_capacity_from_pattern (client-007, 20260926020200, unchanged,
-- service_role only) and records every run in cron_heartbeats through
-- fn_record_cron_run (job-001, unchanged). This seeds its row, so from the
-- first deploy the staleness alert (OPS-005, not built yet) sees a job that
-- has never run (last_run_at NULL) instead of no row at all.
-- No function, grant or capacity rule changes here.

BEGIN;
INSERT INTO cron_heartbeats (job_name) VALUES ('capacity_rollforward') ON CONFLICT (job_name) DO NOTHING;
COMMIT;
