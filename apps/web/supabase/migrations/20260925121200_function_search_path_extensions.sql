-- 20260925121200_function_search_path_extensions.sql
-- Found by the local Supabase-shaped stack (scaffold, 2026-09-25), RED first:
-- on Supabase, pgcrypto and uuid-ossp live in schema "extensions", not
-- "public". Every SECURITY DEFINER function here pins search_path = public,
-- so digest() / gen_random_bytes() / uuid_generate_v4() inside a function body
-- did not resolve: fn_create_standard_order failed with
-- "function digest(text, unknown) does not exist" for every guest checkout.
-- The throwaway-postgres test never saw it because there the extensions were
-- installed into public.
--
-- Fix: same pinned path plus "extensions", and pg_temp last (explicitly, so a
-- temp object can never shadow a public one inside a SECURITY DEFINER body).
-- No function body, signature, grant or owner changes. Applies to every
-- function in public whose config pins search_path to exactly "public".
-- On a plain postgres without schema "extensions" the extra entry is ignored.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proconfig IS NOT NULL
      AND 'search_path=public' = ANY (p.proconfig)
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', r.sig);
  END LOOP;
END $$;
