import 'server-only';
import { z } from 'zod';
import { anonClient } from '@/lib/server/supabase/service';
import { deliveryZonesResponse, type DeliveryZonesResponse } from '@/lib/shared/contracts/checkout';

// Public delivery zones (US-6): active zones, their flat fee and their cities,
// read as anon (RLS delivery_zones_select_public: active only). Read-only.
// The admin CRUD lives in admin-zones.ts (another task). The fee shown here
// is a preview; the order's fee is looked up again from the city by
// fn_create_standard_order (SEC-008).
const row = z.object({
  id: z.string(),
  name: z.string(),
  fee_displayed: z.coerce.number(),
  delivery_zone_cities: z.array(z.object({ city: z.string() })),
});

const collator = new Intl.Collator('he');

export async function getPublicZones(): Promise<DeliveryZonesResponse> {
  const { data, error } = await anonClient()
    .from('delivery_zones')
    .select('id, name, fee_displayed, delivery_zone_cities(city)')
    .eq('is_active', true)
    .order('name');
  if (error) throw new Error(`delivery zones unavailable: ${error.code}`);
  return deliveryZonesResponse.parse({
    zones: z
      .array(row)
      .parse(data)
      .map((z0) => ({
        id: z0.id,
        name: z0.name,
        fee: z0.fee_displayed,
        cities: z0.delivery_zone_cities.map((c) => c.city).sort(collator.compare),
      }))
      .filter((z0) => z0.cities.length > 0),
  });
}
