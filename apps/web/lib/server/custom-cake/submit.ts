import 'server-only';
import { z } from 'zod';
import { serviceClient } from '@/lib/server/supabase/service';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import { createUploadUrls, processIncomingPhotos, type ProcessResult } from '@/lib/server/custom-cake/photos';
import { TEXT_VERSIONS } from '@/lib/shared/compliance/versions';
import type { CustomCakeSubmit, CustomCakeSubmitError, CustomCakeSubmitResponse } from '@/lib/shared/contracts/custom-cake';

// api-005: the customer's custom-cake request. The DB decides everything that
// matters (rate limits, lead time, no capacity touched); this file maps the
// validated input onto fn_submit_custom_cake_request and issues the upload URLs.

export type SubmitResult = { ok: true; value: CustomCakeSubmitResponse } | { ok: false; error: CustomCakeSubmitError; status: number };

export async function submitCustomCakeRequest(input: CustomCakeSubmit, ip: string): Promise<SubmitResult> {
  const service = serviceClient();
  let requestId: string;
  try {
    requestId = await callRpc(
      service,
      'fn_submit_custom_cake_request',
      {
        p_ip_address: ip,
        p_name: input.name,
        p_phone: input.phone,
        p_email: input.email ?? null,
        p_whatsapp_followup_ok: input.whatsappFollowupOk,
        p_inscription: input.inscription,
        p_notes: input.notes,
        p_desired_date: input.desiredDate,
        p_upload_rights_confirmed: input.uploadRightsConfirmed,
        p_privacy_notice_version: TEXT_VERSIONS.privacy,
      },
      z.uuid(),
    );
  } catch (e) {
    if (e instanceof DbError) {
      if (e.code === 'lead_time_not_met') return { ok: false, error: 'lead_time_not_met', status: 422 };
      if (e.code === 'rate_limit_ip_exceeded' || e.code === 'rate_limit_open_requests_per_phone_exceeded') {
        return { ok: false, error: 'rate_limited', status: 429 };
      }
      console.error('custom cake submit failed', e.code); // code only, no PII (SEC-026)
      return { ok: false, error: 'unavailable', status: 503 };
    }
    throw e;
  }

  // The request exists now. If Storage cannot issue upload URLs, the request
  // still stands and the screen tells the customer to send the photo on
  // WhatsApp instead, rather than losing the whole request.
  let urls: string[] = [];
  let photosUnavailable = false;
  if (input.photos.length > 0) {
    try {
      urls = await createUploadUrls(service, requestId, input.photos.length);
    } catch {
      console.error('custom cake upload urls unavailable');
      photosUnavailable = true;
    }
  }
  return { ok: true, value: { requestId, uploads: urls.map((url) => ({ url })), photosUnavailable } };
}

export async function finalizeCustomCakePhotos(requestId: string): Promise<ProcessResult> {
  return processIncomingPhotos(serviceClient(), requestId);
}
