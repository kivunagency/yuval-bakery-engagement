-- Migration: 20260926160000_ops_registry_audit_and_rate_limit
-- DDD context: Shared (audit_log, app_settings; threat-model.md SEC-004, SEC-017)
-- Task: ops-registry-001 (ADR-001 "Rule 27: operations registry: GO").
--
-- The persistent, append-only audit sink the operations registry needs
-- (agent-ops-registry/SECURITY.md section E), and its per-token rate limit
-- (section G, threat-model 3.7), in audit_log itself:
--
-- 1. fn_ops_registry_call_begin: called by runOne() BEFORE anything else on
--    every dispatch (known or unknown operation, allowed or not). Locks the
--    agent token, counts its calls in the last minute and either records the
--    call ('ops_registry.call') and returns the row id, or records the refusal
--    ('ops_registry.call_rate_limited') and returns NULL. The limit is per
--    agent token, independent of every UI rate limit.
-- 2. fn_ops_registry_call_finish: the outcome of a call that began
--    ('ops_registry.call_result': ok, FORBIDDEN, INVALID_ARGS, ...). A 'call'
--    row with no 'call_result' row is a call that crashed mid-way.
-- 3. fn_ops_registry_token_minted: an admin minted an agent token.
--
-- Every function runs as the admin's own JWT and requires is_admin_aal2(): an
-- agent token only ever carries a delegated admin session (see
-- lib/server/agent-ops/SECURITY.md), so no call reaches here without aal2.
-- The actor is derived from auth.uid() (metadata.delegated_by), never from a
-- parameter. actor_type 'agent' and actor_id 'agent-token:<jti>' were
-- reserved for this in 20260925120700. The app redacts the input before it
-- gets here (REDACT_KEYS, SEC-017); this file only caps its size.
-- The business functions the operations call (fn_mark_order_paid, ...)
-- still write their own audit rows with auth.uid(), unchanged.

BEGIN;

INSERT INTO app_settings (key, value, description) VALUES
  ('ops_registry_calls_per_token_per_minute', '60', 'ops-registry-001 (SEC-004, agent-ops-registry SECURITY.md G): calls one agent token may make per minute over the MCP endpoint, independent of the UI rate limits. invoke counts as a call and so does each call inside it.')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS audit_log_agent_calls_idx ON audit_log (actor_id, created_at) WHERE actor_type = 'agent';

CREATE OR REPLACE FUNCTION fn_ops_registry_call_begin(p_token_id TEXT, p_operation TEXT, p_role TEXT, p_input JSONB)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_limit INT := (SELECT value::text::int FROM app_settings WHERE key = 'ops_registry_calls_per_token_per_minute');
  v_actor TEXT;
  v_input JSONB := coalesce(p_input, '{}'::jsonb);
  v_id BIGINT;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'retention_setting_missing: ops_registry_calls_per_token_per_minute';
  END IF;
  IF p_token_id IS NULL OR p_token_id !~ '^[A-Za-z0-9_-]{16,64}$' OR p_role IS NULL OR p_role !~ '^[a-z]{1,20}$' THEN
    RAISE EXCEPTION 'ops_registry_invalid_argument';
  END IF;
  v_actor := 'agent-token:' || p_token_id;
  -- The operation name comes from the agent; keep it bounded, it is only a label here.
  IF length(v_input::text) > 4000 THEN
    v_input := jsonb_build_object('truncated', true);
  END IF;

  -- Serialize the calls of one token so parallel calls cannot all slip under the limit.
  PERFORM pg_advisory_xact_lock(hashtext('ops_registry:' || p_token_id));

  IF (SELECT count(*) FROM audit_log
      WHERE actor_type = 'agent' AND actor_id = v_actor AND action = 'ops_registry.call'
        AND created_at > now() - interval '1 minute') >= v_limit THEN
    INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, metadata)
    VALUES ('agent', v_actor, 'ops_registry.call_rate_limited', 'ops_operation', left(coalesce(p_operation, ''), 64),
            jsonb_build_object('delegated_by', auth.uid()::text, 'role', p_role));
    RETURN NULL;
  END IF;

  INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, metadata)
  VALUES ('agent', v_actor, 'ops_registry.call', 'ops_operation', left(coalesce(p_operation, ''), 64),
          jsonb_build_object('delegated_by', auth.uid()::text, 'role', p_role, 'input', v_input))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION fn_ops_registry_call_begin IS 'ops-registry-001: audit + per-token rate limit for one registry dispatch. NULL = over the limit (the refusal is audited). Admin aal2 JWT only.';

CREATE OR REPLACE FUNCTION fn_ops_registry_call_finish(p_call_id BIGINT, p_token_id TEXT, p_outcome TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_call audit_log%ROWTYPE;
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_outcome IS NULL OR p_outcome !~ '^(ok|[A-Z_]{2,40})$' THEN
    RAISE EXCEPTION 'ops_registry_invalid_argument';
  END IF;
  -- Only the admin whose token began the call can close it.
  SELECT * INTO v_call FROM audit_log
  WHERE id = p_call_id AND action = 'ops_registry.call' AND actor_id = 'agent-token:' || p_token_id
    AND metadata ->> 'delegated_by' = auth.uid()::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ops_registry_invalid_argument';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, metadata)
  VALUES ('agent', v_call.actor_id, 'ops_registry.call_result', 'ops_operation', v_call.entity_id,
          jsonb_build_object('delegated_by', auth.uid()::text, 'call_id', p_call_id, 'outcome', p_outcome));
END;
$$;
COMMENT ON FUNCTION fn_ops_registry_call_finish IS 'ops-registry-001: the outcome of a registry call that fn_ops_registry_call_begin recorded. Admin aal2 JWT only, and only the admin that began it.';

CREATE OR REPLACE FUNCTION fn_ops_registry_token_minted(p_token_id TEXT, p_role TEXT, p_expires_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NOT is_admin_aal2() THEN
    RAISE EXCEPTION 'admin_aal2_required';
  END IF;
  IF p_token_id IS NULL OR p_token_id !~ '^[A-Za-z0-9_-]{16,64}$' OR p_role IS NULL OR p_role !~ '^[a-z]{1,20}$'
     OR p_expires_at IS NULL OR p_expires_at > now() + interval '1 hour 1 minute' THEN
    RAISE EXCEPTION 'ops_registry_invalid_argument';
  END IF;
  PERFORM fn_write_audit_log('admin', auth.uid()::text, 'ops_registry.token_minted', 'agent_token', p_token_id,
    jsonb_build_object('role', p_role, 'expires_at', p_expires_at));
END;
$$;
COMMENT ON FUNCTION fn_ops_registry_token_minted IS 'ops-registry-001: audit row for an agent token minted by an admin at aal2 (lifetime at most one hour, SEC-004).';

REVOKE EXECUTE ON FUNCTION fn_ops_registry_call_begin(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_ops_registry_call_finish(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION fn_ops_registry_token_minted(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
-- authenticated only: each function checks is_admin_aal2() itself. No anon grant.
GRANT EXECUTE ON FUNCTION fn_ops_registry_call_begin(TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_ops_registry_call_finish(BIGINT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_ops_registry_token_minted(TEXT, TEXT, TIMESTAMPTZ) TO authenticated;

COMMIT;
