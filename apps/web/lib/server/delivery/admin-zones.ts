import 'server-only';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRpc, DbError } from '@/lib/server/supabase/rpc';
import {
  toAdminDeliveryZone,
  zoneRow,
  type AdminDeliveryZone,
  type DeliveryZonesApiErrorBody,
  type ZoneCreate,
  type ZonePatch,
} from '@/lib/shared/contracts/delivery-zones';

// Admin reads and writes of delivery zones (api-007, US-6). `client` is always
// createUserClient(): RLS lets an aal2 admin read every zone, and the write
// functions check aal2 again, validate, and audit with auth.uid() (SEC-017).
// The public checkout read lives in public-zones.ts, not here.

export type ZoneResult<T> = { ok: true; value: T } | { ok: false; status: number; body: DeliveryZonesApiErrorBody };

const listRow = z.object({
  id: z.string(),
  name: z.string(),
  fee_displayed: z.coerce.number(),
  is_active: z.boolean(),
  delivery_zone_cities: z.array(z.object({ city: z.string() })),
});

/** Every zone, active or not, with its cities, ordered by name. */
export async function listZonesForAdmin(client: SupabaseClient): Promise<AdminDeliveryZone[]> {
  const { data, error } = await client
    .from('delivery_zones')
    .select('id, name, fee_displayed, is_active, delivery_zone_cities(city)')
    .order('name');
  if (error) throw new Error('delivery_zones_read_failed');
  return z
    .array(listRow)
    .parse(data)
    .map((r) =>
      toAdminDeliveryZone({
        id: r.id,
        name: r.name,
        fee: r.fee_displayed,
        is_active: r.is_active,
        cities: r.delivery_zone_cities.map((c) => c.city).sort((a, b) => a.localeCompare(b, 'he')),
      }),
    );
}

/** Maps a DB error from a zone function to an HTTP answer. */
async function zoneErrorResult(client: SupabaseClient, e: unknown): Promise<ZoneResult<never>> {
  if (e instanceof DbError) {
    switch (e.code) {
      case 'admin_aal2_required':
        return { ok: false, status: 401, body: { error: 'unauthorized' } };
      case 'delivery_zone_invalid':
        return { ok: false, status: 400, body: { error: 'invalid_input' } };
      case 'delivery_zone_name_taken':
        return { ok: false, status: 409, body: { error: 'name_taken' } };
      case 'delivery_zone_not_found':
        return { ok: false, status: 404, body: { error: 'not_found' } };
      case 'delivery_city_in_other_zone': {
        // The DB raises 'delivery_city_in_other_zone: <city>'; name the zone that has it.
        const city = e.raw.slice(e.raw.indexOf(':') + 1).trim();
        const { data } = await client.from('delivery_zone_cities').select('delivery_zones(name)').eq('city', city).maybeSingle();
        const owner = (data as { delivery_zones?: { name?: string } | null } | null)?.delivery_zones?.name;
        return { ok: false, status: 409, body: { error: 'city_in_other_zone', city, ...(owner ? { zoneName: owner } : {}) } };
      }
    }
  }
  return { ok: false, status: 500, body: { error: 'server_error' } };
}

export async function createDeliveryZone(client: SupabaseClient, input: ZoneCreate): Promise<ZoneResult<AdminDeliveryZone>> {
  try {
    const row = await callRpc(client, 'fn_admin_create_delivery_zone', { p_name: input.name, p_fee: input.fee, p_cities: input.cities }, zoneRow);
    return { ok: true, value: toAdminDeliveryZone(row) };
  } catch (e) {
    return zoneErrorResult(client, e);
  }
}

export async function updateDeliveryZone(client: SupabaseClient, id: string, input: ZonePatch): Promise<ZoneResult<AdminDeliveryZone>> {
  try {
    const row = await callRpc(
      client,
      'fn_admin_update_delivery_zone',
      { p_zone_id: id, p_name: input.name ?? null, p_fee: input.fee ?? null, p_is_active: input.isActive ?? null, p_cities: input.cities ?? null },
      zoneRow,
    );
    return { ok: true, value: toAdminDeliveryZone(row) };
  } catch (e) {
    return zoneErrorResult(client, e);
  }
}

export async function deleteDeliveryZone(client: SupabaseClient, id: string): Promise<ZoneResult<{ deleted: true }>> {
  try {
    await callRpc(client, 'fn_admin_delete_delivery_zone', { p_zone_id: id }, z.literal(true));
    return { ok: true, value: { deleted: true } };
  } catch (e) {
    return zoneErrorResult(client, e);
  }
}
