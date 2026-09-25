import { z } from 'zod';

// Admin delivery-zone contracts (api-007, US-6). The DB functions
// (fn_admin_*_delivery_zone, migration 20260926070000) enforce the same bounds
// again: name 1..40, fee whole shekels 0..1000, city 1..60 after trimming, at
// most 100 cities, and a city in at most one zone.

export const ZONE_FEE_MAX = 1000;
export const ZONE_NAME_MAX = 40;
export const CITY_NAME_MAX = 60;
export const ZONE_CITIES_MAX = 100;

/** Trims and collapses inner whitespace, the same normalization as fn_normalize_city. */
export const normalizeCity = (s: string) => s.trim().replace(/\s+/g, ' ');

export const zoneName = z.string().trim().min(1).max(ZONE_NAME_MAX);
/** Flat fee in whole shekels. */
export const zoneFee = z.number().int().min(0).max(ZONE_FEE_MAX);
export const cityName = z.string().transform(normalizeCity).pipe(z.string().min(1).max(CITY_NAME_MAX));
export const zoneCities = z
  .array(cityName)
  .max(ZONE_CITIES_MAX)
  .transform((cities) => [...new Set(cities)]);

/** POST /api/admin/delivery-zones body. */
export const zoneCreate = z
  .object({
    name: zoneName,
    fee: zoneFee,
    cities: zoneCities.default([]),
  })
  .strict();
export type ZoneCreate = z.infer<typeof zoneCreate>;

/** PATCH /api/admin/delivery-zones/[id] body. Omitted = unchanged; `cities` replaces the whole list. */
export const zonePatch = z
  .object({
    name: zoneName.optional(),
    fee: zoneFee.optional(),
    isActive: z.boolean().optional(),
    cities: zoneCities.optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'empty_patch');
export type ZonePatch = z.infer<typeof zonePatch>;

/** Any 8-4-4-4-12 hex id (z.guid): seed rows use ids that are not RFC 4122 v1-v8. */
export const zoneIdParam = z.guid();

/** What the fn_admin_*_delivery_zone functions return. */
export const zoneRow = z.object({
  id: z.string(),
  name: z.string(),
  fee: z.coerce.number(),
  is_active: z.boolean(),
  cities: z.array(z.string()),
});
export type ZoneRow = z.infer<typeof zoneRow>;

export const adminDeliveryZone = z.object({
  id: z.guid(),
  name: z.string(),
  fee: z.number(),
  isActive: z.boolean(),
  cities: z.array(z.string()),
});
export type AdminDeliveryZone = z.infer<typeof adminDeliveryZone>;

export function toAdminDeliveryZone(row: ZoneRow): AdminDeliveryZone {
  return adminDeliveryZone.parse({ id: row.id, name: row.name, fee: row.fee, isActive: row.is_active, cities: row.cities });
}

export const adminDeliveryZonesResponse = z.object({ zones: z.array(adminDeliveryZone) });
export type AdminDeliveryZonesResponse = z.infer<typeof adminDeliveryZonesResponse>;

/** Error body of the admin delivery-zones API. city_in_other_zone carries the city and the zone that has it. */
export const DELIVERY_ZONES_API_ERRORS = [
  'unauthorized',
  'forbidden_origin',
  'invalid_input',
  'city_in_other_zone',
  'name_taken',
  'not_found',
  'server_error',
] as const;
export type DeliveryZonesApiError = (typeof DELIVERY_ZONES_API_ERRORS)[number];
export const deliveryZonesApiError = z.object({
  error: z.enum(DELIVERY_ZONES_API_ERRORS),
  city: z.string().optional(),
  zoneName: z.string().optional(),
});
export type DeliveryZonesApiErrorBody = z.infer<typeof deliveryZonesApiError>;
