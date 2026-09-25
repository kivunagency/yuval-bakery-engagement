import 'server-only';
import { cache } from 'react';
import { anonClient } from '@/lib/server/supabase/service';
import { callRpc } from '@/lib/server/supabase/rpc';
import { EMPTY_SITE_SETTINGS, publicSiteSettings, type PublicSiteSettings } from '@/lib/shared/contracts/site-settings';

// Public business details, VAT status, document versions and retention
// periods, read with the anon key through the one whitelisting function.
// Cached per request (the footer and the page both ask). If the DB is
// unreachable the page still renders, with placeholders, and the error is
// logged: a missing footer must not take the whole site down.
export const getPublicSiteSettings = cache(async (): Promise<PublicSiteSettings> => {
  try {
    return await callRpc(anonClient(), 'fn_public_site_settings', {}, publicSiteSettings);
  } catch (err) {
    console.error('fn_public_site_settings failed', err);
    return EMPTY_SITE_SETTINGS;
  }
});
