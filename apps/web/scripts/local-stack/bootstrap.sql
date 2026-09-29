-- Roles and schemas a hosted Supabase project already has, recreated for the
-- local stack so migrations run against the same shape. Local stack only.

-- Extensions live in schema "extensions" on Supabase, not "public". Keeping
-- that here makes any function that forgets it fail locally, not in PROD.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$ BEGIN CREATE ROLE anon NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'postgres'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_auth_admin LOGIN CREATEROLE NOINHERIT PASSWORD 'postgres'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT anon, authenticated, service_role TO authenticator;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT USAGE ON SCHEMA auth, public, extensions TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO service_role;
ALTER ROLE supabase_auth_admin SET search_path = auth;

-- Supabase default privileges: new tables in public are reachable by the API
-- roles; RLS and the migrations' own REVOKEs decide what they can actually do.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- Same database-level search_path Supabase sets, so migrations resolve
-- extension functions the way they will on the hosted project.
ALTER DATABASE postgres SET search_path = "$user", public, extensions;
