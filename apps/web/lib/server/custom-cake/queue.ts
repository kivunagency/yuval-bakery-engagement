import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '@/lib/server/supabase/service';
import { signedPhotoUrls } from '@/lib/server/custom-cake/photos';
import type { QueueItem } from '@/lib/shared/contracts/custom-cake';

// The admin queue of custom-cake requests (client-008). Rows are read as the
// admin's own JWT (RLS: custom_cake_requests_select_own_registered lets an
// aal2 admin read, custom_cake_photos_admin_only the photo paths). Photos are
// shown only through short-lived signed URLs minted here, on the server, for
// a caller who already passed requireAdminPage(); the bucket stays private.

const row = z.object({
  id: z.string(),
  requester_name: z.string().nullable(),
  requester_phone: z.string().nullable(),
  requester_email: z.string().nullable(),
  whatsapp_followup_ok: z.boolean(),
  inscription_text: z.string().nullable(),
  notes: z.string().nullable(),
  desired_date: z.string(),
  created_at: z.string(),
  custom_cake_photos: z.array(z.object({ storage_path: z.string() })),
});

/** Pending requests, soonest day first. Call only after requireAdminPage(). */
export async function loadPendingQueue(client: SupabaseClient): Promise<QueueItem[]> {
  const { data, error } = await client
    .from('custom_cake_requests')
    .select('id, requester_name, requester_phone, requester_email, whatsapp_followup_ok, inscription_text, notes, desired_date, created_at, custom_cake_photos(storage_path)')
    .eq('status', 'pending_review')
    .order('desired_date')
    .order('created_at');
  if (error) throw new Error('custom_cake_queue_read_failed');
  const rows = z.array(row).parse(data);

  const paths = rows.flatMap((r) => r.custom_cake_photos.map((p) => p.storage_path));
  let urls = new Map<string, string>();
  try {
    urls = await signedPhotoUrls(serviceClient(), paths);
  } catch {
    // Storage unreachable: the queue still works; the screen says the photos cannot be shown.
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.requester_name,
    phone: r.requester_phone,
    email: r.requester_email,
    whatsappOk: r.whatsapp_followup_ok,
    inscription: r.inscription_text,
    notes: r.notes,
    desiredDate: r.desired_date,
    createdAt: r.created_at,
    photos: r.custom_cake_photos.map((p) => ({ path: p.storage_path, url: urls.get(p.storage_path) ?? null })),
  }));
}
