// Domain types shared by server and client (shared-001). No I/O here.
// Status and enum values mirror the CHECK constraints in supabase/migrations;
// tests/shared-types.test.ts fails if a migration changes them.

export const ORDER_STATUSES = ['payment_pending', 'paid', 'fulfilled', 'expired', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const FULFILLMENT_TYPES = ['delivery', 'pickup'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const ORDER_SOURCES = ['standard', 'custom_cake'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const CONFIRMATION_CHANNELS = ['email', 'whatsapp_manual'] as const;
export type ConfirmationChannel = (typeof CONFIRMATION_CHANNELS)[number];

export const CUSTOM_CAKE_STATUSES = ['pending_review', 'approved', 'declined'] as const;
export type CustomCakeStatus = (typeof CUSTOM_CAKE_STATUSES)[number];

export const COST_BASES = ['per_unit', 'per_batch'] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** ISO calendar date, YYYY-MM-DD, always meant in Asia/Jerusalem. */
export type IsoDate = string;
/** Money as shown to the customer, VAT status per app_settings.vat_status. */
export type Money = number;

export type Product = {
  id: string;
  name: string;
  description: string | null;
  priceDisplayed: Money;
  costBasis: CostBasis;
  ovenMinutesCost: number;
  workMinutesCost: number;
  ingredients: string | null;
  allergens: string[];
  allergenNotes: string | null;
  photoAlt: string | null;
  isAvailable: boolean;
};

export type ProductPhoto = { id: string; productId: string; storagePath: string; altText: string | null; position: number };

/** What a customer may see about a day: a state word, never the minutes (design-tokens.md). */
export const DAY_STATES = ['open', 'limited', 'full', 'closed', 'too_soon'] as const;
export type DayState = (typeof DAY_STATES)[number];

/** Admin view of one ledger row. */
export type DayCapacity = {
  day: IsoDate;
  ovenMinutesTotal: number;
  ovenMinutesReserved: number;
  ovenMinutesUnpaidReserved: number;
  workMinutesTotal: number;
  workMinutesReserved: number;
  workMinutesUnpaidReserved: number;
  isBlackout: boolean;
};

export type DeliveryZone = { id: string; name: string; feeDisplayed: Money; isActive: boolean; cities: string[] };

export type OrderLine = { productId: string | null; productName: string; unitPrice: Money; quantity: number; lineTotal: Money };

export type Order = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  source: OrderSource;
  fulfillmentType: FulfillmentType;
  deliveryDate: IsoDate;
  deliveryTimeWindow: string | null;
  deliveryCity: string | null;
  subtotal: Money;
  deliveryFee: Money;
  total: Money;
  paymentPendingExpiresAt: string | null;
  createdAt: string;
  lines: OrderLine[];
};

export type CustomCakeRequest = {
  id: string;
  status: CustomCakeStatus;
  desiredDate: IsoDate;
  inscriptionText: string | null;
  notes: string | null;
  priceDisplayed: Money | null;
  ovenMinutesCost: number | null;
  workMinutesCost: number | null;
  declineReason: string | null;
  orderId: string | null;
  createdAt: string;
};
