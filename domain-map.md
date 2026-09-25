---
client: yuval-bakery
doc: domain-map
status: draft (alex, Phase 2 of build-pipeline)
created: 2026-09-25
source: PRD-01-ordering-app.md (approved 2026-09-25)
---

# YuvalBakery Domain Map

This is a single Next.js monolith. DDD here is a logical decomposition (folder
boundaries, one aggregate owning one write path), not a microservices split.
There is one deployable, one database, and one team of agents building it.

## 1. Bounded Contexts

| Context | Aggregate root | Owns | Type |
|---|---|---|---|
| **Catalog** | `Product` | products, photos, prices, ingredients, allergens, availability toggle | Supporting |
| **Capacity** | `DayCapacity` | oven-minute pool, work-minute pool per day, blackout flag, atomic reserve/release | Core (the correctness-critical one) |
| **Ordering** | `Order` | cart to checkout, order state machine, order lines, order number, payment-pending expiry | Core |
| **CustomCake** | `CustomCakeRequest` | inscription, inspiration photo, review/approve/decline, becomes an `Order` on approval | Core |
| **Delivery** | `DeliveryZone` | zones by city, flat fee per zone, daily delivery list generation for the uncle | Supporting |
| **Identity** | `Customer`, `AdminUser` | guest vs registered customer, admin login + MFA, s.30A marketing opt-in flag | Generic (mostly Supabase Auth) |
| **Notification** | `NotificationEvent` | web push, email, WhatsApp click-to-send link generation | Supporting |
| **Loyalty** (Phase 2) | `PunchCard`, `Promotion` | punch cards, birthday/anniversary sends, promotions, stacking rules | Supporting, deferred |

Compliance concerns (privacy notice, s.11/s.14C text, retention policy, Rule 33
public-site baseline) are cross-cutting, not a context of their own: they live
as content + gates attached to Catalog/Ordering/Identity screens, owned by
rotem, tagged `domain: compliance` in tasks.json only where the artifact is a
standalone deliverable (privacy notice page, accessibility statement).

## 2. Aggregates and invariants

- **`DayCapacity`** (Capacity): for a given `date`, `oven_minutes_total`,
  `oven_minutes_reserved`, `work_minutes_total`, `work_minutes_reserved`.
  Invariant: `reserved <= total` for both resources, always, even under
  concurrent writers. This is the one invariant amit asserts directly
  (Rule 17) and is named `capacity_never_negative` in ADR-002.
- **`Order`** (Ordering): one order = one or more order lines, a state
  (`payment_pending -> paid -> fulfilled`, or `expired`/`cancelled`), a
  capacity hold reference per line's product/day. An `Order` cannot exist in
  `payment_pending` without a corresponding successful `DayCapacity` reserve
  in the same transaction (see ADR-002).
- **`CustomCakeRequest`** (CustomCake): starts with no time cost and no
  capacity hold. `approve()` sets price + time cost and is the ONE operation
  that both creates an `Order` and calls `DayCapacity.reserve()` for a
  request. This is the cross-context write this domain map exists to make
  explicit: CustomCake context creates an Ordering aggregate. Modeled as a
  single server-side transaction inside `lib/server/custom-cake/approve.ts`,
  not an async event, because the whole point is that it must not race with
  a standard-product checkout for the same day (same DB transaction, same
  `DayCapacity` row lock).
- **`DeliveryZone`** (Delivery): a city belongs to at most one zone. Read at
  checkout (Ordering context) via a plain query, not an event, since it is
  read-only pricing lookup, not a state change.
- **`Customer`** (Identity): guest orders carry no `customer_id`. A
  registered `Customer` has an optional `marketing_opt_in` boolean, default
  `false`, settable only via its own explicit action (never bundled into the
  registration submit), per Communications Law s.30A.

## 3. Domain events (informal, in-process function calls today, not a bus)

Given this is one Next.js server, "events" are direct function calls inside
one transaction, not a message bus. Naming them as events keeps the seam
visible for the day this needs to split (e.g., if WhatsApp Cloud API or a
payment webhook arrives in Phase 2 and something genuinely needs to be async).

- `OrderCreated` (Ordering) -> Notification context sends push+email to Yuval
- `CustomCakeApproved` (CustomCake) -> creates `Order` in Ordering (sync, same transaction) -> Notification sends approval message to customer
- `CustomCakeDeclined` (CustomCake) -> Notification sends decline message to customer
- `OrderExpired` (Ordering, scheduled sweep) -> Capacity releases the hold (sync, same transaction, not a separate event in practice)
- `OrderPaid` (Ordering, admin action) -> (Phase 2) Loyalty evaluates punch-card eligibility

## 4. Context map

```
Catalog ---(product time-costs, read)---> Capacity
Catalog ---(product line, read)---------> Ordering
CustomCake --(reserve on approve)-------> Capacity   [same transaction]
CustomCake --(creates)-------------------> Ordering   [same transaction, Conformist: CustomCake conforms to Ordering's state machine]
Ordering ---(reserve on checkout)--------> Capacity   [same transaction]
Ordering ---(release on expiry/cancel)---> Capacity   [same transaction]
Ordering ---(zone fee, read)-------------> Delivery
Ordering ---(customer_id, optional)------> Identity
Ordering ---(order created/paid events)--> Notification   [Open Host Service: Notification only reads, never writes into Ordering]
Identity ---(opt-in flag, read)----------> Loyalty (Phase 2)
```

**Capacity is the one context every write-path context depends on
synchronously and none may bypass.** Ordering and CustomCake are both
Conformists to Capacity's `reserve()`/`release()` contract: neither is
allowed its own copy of "is there room" logic (Rule 19 — one shared
definition of the quantity, here "remaining minutes", not two).

## 5. Folder structure (Next.js, Rule 2 layering inside each domain folder)

```
app/
  api/
    catalog/route.ts
    orders/route.ts
    orders/[id]/route.ts
    custom-cake-requests/route.ts
    custom-cake-requests/[id]/approve/route.ts
    custom-cake-requests/[id]/decline/route.ts
    capacity/route.ts
    delivery-zones/route.ts
    delivery-list/route.ts
    customers/route.ts
    admin/... (RBAC-gated)
  (public)/catalog/page.tsx          <- server component, fetches at render (Rule 31)
  (public)/checkout/page.tsx
  (public)/custom-cake/page.tsx
  (admin)/admin/orders/page.tsx
  (admin)/admin/capacity/page.tsx
  (admin)/admin/delivery/page.tsx
lib/
  server/
    catalog/            <- import 'server-only'
    capacity/            <- import 'server-only'; the ONE place reserve()/release() live
    ordering/             <- import 'server-only'
    custom-cake/          <- import 'server-only'
    delivery/             <- import 'server-only'
    identity/             <- import 'server-only'
    notification/         <- import 'server-only'
    loyalty/               <- import 'server-only' (Phase 2 stub folder only)
  shared/
    types/                <- Order, Product, DayCapacity, etc, used by both server and client
    constants/
components/               <- client components, UI only
```

## 6. Glossary (Hebrew / English)

| English (code, API, DB) | Hebrew (UI, he.json) |
|---|---|
| Product | מוצר |
| Order | הזמנה |
| Order number | מספר הזמנה |
| Custom cake request | בקשת עוגה בהתאמה אישית |
| Oven minutes | דקות תנור |
| Work minutes | דקות עבודה |
| Day capacity | קיבולת יומית |
| Blackout day | יום חסום |
| Delivery zone | אזור משלוח |
| Guest checkout | רכישה כאורח |
| Registered customer | לקוח רשום |
| Payment pending | ממתין לתשלום |
| Paid | שולם |
| Fulfilled | סופק |
| Expired | פג תוקף |
| Cancelled | בוטל |
| Punch card (Phase 2) | כרטיסיית הנחה |
| Marketing opt-in | הסכמה לדיוור שיווקי |

## 7. Balance check (Rule DDD context balance)

Task count per domain is reported in tasks.json; ordering + capacity together
(the two core contexts) are expected to carry the largest share given the
correctness requirement, but neither exceeds 40% individually. See the task
count table at the end of tasks.json generation; flagged to Ran if any single
domain crosses 40% of total story points.

[[agents/alex]] [[yuval-bakery]] [[ADR-DDD-001-domain-model]]
