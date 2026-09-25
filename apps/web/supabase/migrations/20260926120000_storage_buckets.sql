-- 20260926120000_storage_buckets.sql (orchestrator lane 1200xx)
-- The two Storage buckets (DB-PLAN.md section 9 DID NOT RUN item, SEC-010,
-- SEC-011). Buckets are rows in storage.buckets, which Supabase Storage
-- creates on a hosted project and the local stack's storage server creates
-- before these migrations run. On a plain postgres (output/db/tests/run.sh)
-- there is no storage schema, so this migration does nothing there.
--
-- No storage.objects policy is created for anon or authenticated, on purpose:
-- RLS on storage.objects denies them everything. Every read and write goes
-- through the server with the service-role key:
--   product-photos           public READ by URL (the catalog), writes only by
--                            the server after an aal2 admin action (SEC-011).
--   custom-cake-inspiration  private: browser PUTs only to a signed,
--                            single-use upload URL the server issued; the
--                            server re-encodes; the admin views through
--                            short signed URLs (SEC-010, lib/server/custom-cake/photos.ts).
-- Size and type limits match lib/shared/contracts/custom-cake.ts
-- (10 MB; jpeg, png, webp) so the bucket refuses what the API refuses.

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE NOTICE 'storage schema not present (plain postgres): buckets skipped';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES
    ('product-photos', 'product-photos', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp']),
    ('custom-cake-inspiration', 'custom-cake-inspiration', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO UPDATE
    SET public = EXCLUDED.public,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
END $$;
