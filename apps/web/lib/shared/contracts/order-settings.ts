import { z } from 'zod';

// Time slots and order rules editor (settings-slots). The DB functions
// fn_admin_set_time_slots / fn_admin_set_order_rules (migration
// 20260926150200) and trg_app_settings_guard repeat every rule here.

export const SLOTS_MAX = 12;
export const SLOT_MIN_MINUTES = 30;
export const SLOT_MAX_MINUTES = 720;

export const ORDER_RULES = {
  expiryHoursStandard: { key: 'payment_pending_expiry_hours_standard', min: 1, max: 72 },
  expiryHoursCustomCake: { key: 'payment_pending_expiry_hours_custom_cake', min: 1, max: 168 },
  limitedThresholdPct: { key: 'day_limited_threshold_pct', min: 1, max: 99 },
} as const;
export type OrderRule = keyof typeof ORDER_RULES;
export const ORDER_RULE_NAMES = Object.keys(ORDER_RULES) as OrderRule[];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const slotInput = z
  .object({ start: hhmm, end: hhmm })
  .strict()
  .refine((s) => {
    const len = minutesOf(s.end) - minutesOf(s.start);
    return len >= SLOT_MIN_MINUTES && len <= SLOT_MAX_MINUTES;
  }, 'length');

/** True when two slots share time (touching ends do not). */
export const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) =>
  minutesOf(a.start) < minutesOf(b.end) && minutesOf(b.start) < minutesOf(a.end);

/** PUT /api/admin/settings/time-slots body: the whole active list. */
export const timeSlotsUpdate = z
  .object({ slots: z.array(slotInput).min(1).max(SLOTS_MAX) })
  .strict()
  .refine((b) => b.slots.every((a, i) => b.slots.every((c, j) => i === j || !overlaps(a, c))), { message: 'overlap', path: ['slots'] })
  .transform((b) => ({ slots: [...b.slots].sort((a, c) => minutesOf(a.start) - minutesOf(c.start)) }));
export type TimeSlotsUpdate = z.infer<typeof timeSlotsUpdate>;

/** Which slot rows are invalid (by index) and whether any two overlap, for the form. */
export function slotProblems(slots: { start: string; end: string }[]): { invalid: number[]; overlap: boolean; count: boolean } {
  const invalid = slots.map((s, i) => (slotInput.safeParse(s).success ? -1 : i)).filter((i) => i >= 0);
  const overlap = slots.some((a, i) => slots.some((c, j) => i !== j && invalid.indexOf(i) < 0 && invalid.indexOf(j) < 0 && overlaps(a, c)));
  return { invalid, overlap, count: slots.length < 1 || slots.length > SLOTS_MAX };
}

const rule = (r: OrderRule) => z.number().int().min(ORDER_RULES[r].min).max(ORDER_RULES[r].max);

/** PUT /api/admin/settings/order-rules body. Omitted = unchanged. */
export const orderRulesUpdate = z
  .object({
    expiryHoursStandard: rule('expiryHoursStandard').optional(),
    expiryHoursCustomCake: rule('expiryHoursCustomCake').optional(),
    limitedThresholdPct: rule('limitedThresholdPct').optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'empty_update');
export type OrderRulesUpdate = z.infer<typeof orderRulesUpdate>;

export function invalidOrderRuleFields(raw: unknown): string[] {
  const r = orderRulesUpdate.safeParse(raw);
  if (r.success) return [];
  return [...new Set(r.error.issues.map((i) => String(i.path[0] ?? '')).filter(Boolean))];
}

export const adminSlot = z.object({ id: z.string(), start: hhmm, end: hhmm });
export type AdminSlot = z.infer<typeof adminSlot>;

export const orderSettings = z.object({
  slots: z.array(adminSlot),
  /** Derived from the first active slot (api-003); null when unreadable. */
  earliestSlotTime: z.string().nullable(),
  rules: z.object(
    Object.fromEntries(ORDER_RULE_NAMES.map((r) => [r, z.object({ value: z.number().nullable(), confirmed: z.boolean() })])) as Record<
      OrderRule,
      z.ZodObject<{ value: z.ZodNullable<z.ZodNumber>; confirmed: z.ZodBoolean }>
    >,
  ),
});
export type OrderSettings = z.infer<typeof orderSettings>;

export const ORDER_SETTINGS_API_ERRORS = ['unauthorized', 'forbidden_origin', 'invalid_input', 'overlap', 'server_error'] as const;
export const orderSettingsApiError = z.object({ error: z.enum(ORDER_SETTINGS_API_ERRORS), fields: z.array(z.string()).optional() });
export type OrderSettingsApiErrorBody = z.infer<typeof orderSettingsApiError>;
