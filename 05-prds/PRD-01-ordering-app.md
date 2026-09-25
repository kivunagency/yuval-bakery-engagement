---
client: yuval-bakery
doc: PRD-01-ordering-app
status: approved (Ran, 2026-09-25)
created: 2026-09-25
owner: maya
links: [[agents/maya]] [[agents/ran]] [[yuval-bakery]]
---

# PRD-01: YuvalBakery Ordering App

Source of truth for scope. Written in English per Rule 1 (English-first system code and specs); the shipped product UI is Hebrew, defined separately in `he.json` and design tokens, not in this document.

## 1. Summary

A public ordering PWA (linked from Instagram bio) plus an admin area, for a single home food-producer bakery (Yuval). Customers browse a catalog, order stock products or request a custom cake, choose delivery or pickup within a 24-hour minimum lead time, and pay by link-out to Bit or PayBox. Yuval runs the entire operation (catalog, capacity, orders, delivery pricing, loyalty) from the admin, with no developer involvement after launch. This PRD converts the approved BRIEF.md decisions (commit `ed7af55`, 2026-09-25) into implementable scope. All bracketed BRIEF decisions are treated as final; only the items the BRIEF itself left open are listed as open questions in Section 10.

## 2. Personas

1. **Guest customer**: arrives from Instagram, no account. Can browse, order, and check out without registering. Provides name, phone, delivery/pickup details per order. No persistent profile; no loyalty benefits (loyalty requires registration by BRIEF decision, see Section 6).
2. **Registered customer**: created an optional profile (name, phone, email, optionally birthday/anniversary date). Retains order history, is eligible for loyalty benefits (punch cards, birthday/anniversary offers, promotions) if opted in to marketing messages. Checkout is faster (saved details) but not functionally different from guest checkout otherwise.
3. **Yuval (owner/admin)**: sole business operator. Manages catalog (products, photos, prices, ingredients, allergens), daily capacity (oven minutes, work minutes, blackout days), delivery pricing settings, incoming orders (including custom-cake approval and pricing), marks orders paid, sends loyalty benefits and promotions, and generates the daily delivery list for the uncle. Uses the admin primarily on mobile/tablet; a desktop-capable responsive layout is in scope, a distinct desktop-optimized pass is not (per engagement.md Section 2, confirm need in Phase 2).
4. **Uncle-driver**: data recipient, not a system user with login in MVP. Receives the daily delivery list (name, address, phone, time window) as a static, printable/shareable view Yuval generates or shares with him (e.g., PDF/print view, or WhatsApp share) each delivery day. No account, no admin access, no app installation required in MVP. (Open question: does he need his own read-only "today's deliveries" view in Phase 2? See Section 10.)

## 3. MVP User Stories and Acceptance Criteria

### 3.1 Catalog browsing (guest and registered)
- **US-1**: As a customer, I can browse a catalog of products with photos, prices, ingredients, and allergens, so I can decide what to order.
  - AC: every product shows photo(s), name, price (incl. VAT), ingredient list, and allergen list.
  - AC: a product Yuval marks unavailable (out of stock / paused) is visibly disabled, not orderable.
  - AC: catalog is usable and readable on mobile (primary traffic source is Instagram bio link).

### 3.2 Custom cake request
- **US-2**: As a customer, I can request a custom cake with a free-text inscription and an inspiration photo upload, so I can order something not in the standard catalog.
  - AC: the request form captures: inscription text, one or more inspiration photo uploads, desired delivery/pickup date, and free-text notes.
  - AC: submitting a custom-cake request does NOT create a payable order and does NOT reserve capacity yet; it creates a request in `pending_review` state.
  - AC: Yuval reviews the request in admin, sets a price and a time cost (oven minutes + work minutes), and either approves or declines it.
  - AC: on approval, the system checks capacity for the requested day using the time cost Yuval set; if capacity is insufficient, Yuval is warned before confirming and must pick another day or override with an explicit acknowledgment (never a silent overbook).
  - AC: on approval, the customer is notified (email, and web push if registered) that the custom cake is approved, with price and a payment link; the order enters `payment_pending`.
  - AC: on decline, the customer is notified with an optional reason field Yuval can fill in.
  - AC: uploaded inspiration photos are private to Yuval's review (not published to the public catalog) unless Yuval explicitly chooses to reuse an image in the catalog later, as a separate action.

### 3.3 Checkout: guest and registered
- **US-3**: As a customer, I can complete an order as a guest without creating an account.
  - AC: guest checkout requires only name, phone, and delivery/pickup details, and, for delivery, the address.
  - AC: no password, no forced account creation, at any step of guest checkout.
- **US-4**: As a customer, I can optionally register a profile to save my details and become eligible for loyalty benefits.
  - AC: registration is offered, never forced, at any point before or after an order.
  - AC: registration is a separate action from the (unticked) marketing/loyalty opt-in required by Communications Law s.30A (see Section 8).

### 3.4 Delivery or pickup, date/time, lead time
- **US-5**: As a customer, I choose delivery or pickup, and a date and time slot, so I know when I will get my order.
  - AC: only dates at least 24 hours from the current time are selectable (minimum lead time, per BRIEF).
  - AC: available dates reflect the day's remaining oven-minute and work-minute capacity against everything already in the product's time cost (see Section 4).
  - AC: a blackout day (capacity = 0) is not selectable, and is visibly distinct from "fully booked."
  - AC: for delivery, the customer sees the delivery fee for their city's zone (US-6) before confirming, and total price (product + delivery fee, VAT included) before payment (per rotem's pricing-transparency requirement).

### 3.5 Delivery pricing settings (admin)
- **US-6**: As Yuval, I can define delivery zones by city, so delivery fees reflect where my uncle drives. (Changed by Ran 2026-09-25: zones by city, not distance ranges.)
  - AC: admin screen lets Yuval create delivery zones; each zone has a name, a flat fee, and a list of cities (one city or a group of cities). A city belongs to at most one zone.
  - AC: at checkout the customer picks their city from a list of the cities Yuval serves (no free-text city, so no typo mismatch); the zone fee is shown immediately.
  - AC: no geocoding or distance API is used. Delivery pricing has no metered third-party dependency.
  - AC: if the customer's city is not in any zone, checkout shows "delivery not available to this city, pickup only".

### 3.6 Delivery list for the uncle
- **US-7**: As Yuval, I can generate today's (or any day's) delivery list, so my uncle knows where to go.
  - AC: the list shows, per delivery order: recipient name, address, phone, requested time window, and any delivery notes.
  - AC: the list is generated per day and is shareable (printable view and/or a link Yuval can send, e.g. via WhatsApp) without requiring the uncle to log into anything.
  - AC: the privacy notice names the uncle as a data recipient for delivery orders (Section 8).

### 3.7 Payment (link-out, manual confirmation)
- **US-8**: As a customer, I pay via a link-out to Yuval's Bit or PayBox, with my order number in the payment note, so Yuval can match my payment to my order.
  - AC: after checkout, the order is created in `payment_pending` state with a unique, customer-facing order number.
  - AC: the confirmation screen shows the Bit/PayBox link (Yuval's own, preset-amount where the tool supports it) and instructs the customer to put the order number in the payment note.
  - AC: no card or bank data is collected or stored by the system at any point (link-out only, no PCI scope).
  - AC: Yuval marks the order `paid` manually in admin once she sees the payment; this is the sole confirmation mechanism in MVP.
- **US-9 (payment-pending expiry)**: As Yuval, I don't want unpaid orders holding capacity forever.
  - AC: an order in `payment_pending` releases its held capacity (oven minutes, work minutes) automatically if not marked `paid` within a configurable expiry window.
  - AC: **default expiry: 4 hours** for standard products, **24 hours** for approved custom cakes (since the customer needed time to review a manually-set price). **Both defaults are flagged for Yuval to confirm or change** before launch. She may prefer shorter (faster resale of a scarce slot) or longer (more forgiving of slow bank-app users); this is a business-risk tradeoff only she can set, not a technical one.
  - AC: the customer is notified before expiry is enforced only if technically simple (e.g., a reminder at 75% of the window); this is a nice-to-have, not a blocking AC.
  - AC: an expired order is visibly distinguishable from a cancelled one in admin (different terminal state, see Section 5), so Yuval can see how much revenue is being lost to non-payment.

### 3.8 New-order notifications (Yuval)
- **US-10**: As Yuval, I am notified immediately when a new order or custom-cake request arrives, so I don't check the app all day.
  - AC: web push notification fires on new order, new custom-cake request, and (Phase 2, if built) automated WhatsApp.
  - AC: email notification fires on the same events, as a non-push fallback (push can be missed/disabled).
  - AC: notification includes order number, customer name, and a direct link into the admin order view.

### 3.9 WhatsApp click-to-send (admin, MVP)
- **US-11**: As Yuval, I can message a customer on WhatsApp about their order with one click, without typing from scratch.
  - AC: each order/request in admin has a "message on WhatsApp" action that opens `wa.me` (or `api.whatsapp.com/send`) with a prefilled message (order number, and templated context appropriate to the order's state, e.g. "your custom cake is approved, price is X") in Yuval's own WhatsApp.
  - AC: this is manual and per-order; no automated/triggered WhatsApp sending exists in MVP (explicitly deferred to Phase 2 per BRIEF).

### 3.10 Content management (Yuval, self-service)
- **US-12**: As Yuval, I manage the entire catalog and business settings myself with no developer involvement.
  - AC: admin CRUD for products (name, photos, price, ingredients, allergens, per-unit/per-batch oven minutes and work minutes, availability toggle).
  - AC: admin screen for daily capacity (oven minutes, work minutes per day; blackout-day toggle sets both to 0).
  - AC: admin screen for delivery pricing settings (Section 3.5).
  - AC: all of the above are usable without touching code or contacting Kivun.

## 4. Capacity Model

- Capacity is resource-based, not a per-item count: every day has an available pool of **oven minutes** and **work minutes**, set by Yuval (default: her standing weekly pattern, overridable per day; blackout day sets both to 0).
- Every product (and every approved custom cake) declares an oven-minute cost and a work-minute cost, per unit or per batch as Yuval defines it.
- An order (or an approved custom cake) is accepted for a given day only if that day's remaining oven-minute AND work-minute pools are both sufficient after the order.
- **Enforcement is atomic at the database level** (not in application code): two customers checking out for the last slot on the same day must never both succeed. This is a hard correctness requirement carried into `db/schema.sql` (dba owns the design: a resource-ledger table with a transactional decrement/constraint, e.g., a `CHECK` against a running total inside the same transaction as order insert, or `SELECT ... FOR UPDATE` on the day's capacity row).
- Reserved (not yet paid) capacity is held from the moment an order reaches `payment_pending`, and released back to the pool on expiry (Section 3.7) or cancellation.
- Custom-cake requests do NOT hold capacity while `pending_review` (BRIEF: Yuval hasn't set a time cost yet); capacity is only reserved once Yuval approves and sets the time cost.

## 5. Order State Machine

States (standard product order):
1. `cart` (client-side only, not persisted as an order)
2. `payment_pending`: order created, order number issued, capacity reserved, payment link shown. Entered from checkout.
3. `paid`: Yuval manually confirmed payment. Entered from `payment_pending` only.
4. `fulfilled`: delivered or picked up. Entered from `paid` only.
5. `expired`: capacity released automatically after the expiry window (Section 3.7) with no payment confirmation. Terminal. Entered from `payment_pending` only.
6. `cancelled`: cancelled by Yuval (or, if built, by the customer before payment) before payment. Terminal. Entered from `payment_pending` only.

States (custom-cake request, precedes the order states above):
1. `pending_review`: submitted by customer, no price/time cost set, no capacity held.
2. `approved`: Yuval set price and time cost, capacity check passed and reserved; transitions immediately into order state `payment_pending` (Section 4) with its own expiry window (24h default).
3. `declined`: terminal, customer notified, no capacity ever held.

State diagram (standard order):
```
cart -> payment_pending -> paid -> fulfilled
payment_pending -> expired      (auto, on timeout)
payment_pending -> cancelled    (manual)
```

State diagram (custom cake):
```
pending_review -> approved -> payment_pending -> paid -> fulfilled
pending_review -> declined  (terminal)
approved -> payment_pending -> expired    (auto, on timeout, 24h default)
```

Only Yuval (admin) can move an order from `payment_pending` to `paid`. No customer-facing or automated payment confirmation exists in MVP (no webhook from Bit/PayBox is available, per eitan's pre-PRD finding: unverified, no public API).

## 6. Loyalty Rules

Loyalty applies only to **registered, opted-in** customers (BRIEF: guest checkout must remain fully available and is never blocked from ordering; loyalty is an added benefit for those who choose to register and opt in, never a requirement).

- **Punch card**: Yuval defines a punch card per product or product category (e.g., "buy 9 croissants, get the 10th free"). A punch is earned automatically when a qualifying order reaches `paid`. Redemption: the customer (or Yuval on the customer's behalf, in-person) applies an available completed punch card as a discount at checkout; a completed punch card does not expire unless Yuval sets an expiry when creating it.
- **Birthday/anniversary benefit**: if a registered customer has supplied a birthday and/or anniversary date (both are optional, explicitly optional and purpose-stated fields, per rotem), Yuval can trigger a benefit (e.g., a discount code, a free add-on) to send around that date. This is a manually-triggered send in MVP (Yuval reviews and sends, or approves a queued send), not a fully automated recurring campaign job, to keep MVP scope inside "content Yuval manages herself."
- **Promotions**: Yuval creates a promotion (discount, time-limited offer) and sends it to some or all opted-in registered customers.
- **Delivery mechanism**: loyalty and promotional messages are sent to customers via **email** (registered customers provide an email) as the default channel, since automated WhatsApp is explicitly Phase 2. WhatsApp click-to-send (Section 3.9) is per-order/per-customer, one at a time, and is impractical for a promotion blast to many customers, it stays as the 1:1 tool, not the loyalty broadcast channel.
- **Stacking rules**: a punch-card redemption and a promotion discount may both apply to the same order only if Yuval's promotion is explicitly marked "stackable" when she creates it; the default for a new promotion is non-stackable, to avoid Yuval accidentally giving away more margin than intended. Birthday/anniversary benefits follow the same stackable flag.
- **Opt-in**: sending ANY loyalty/promotional message requires the customer's explicit, separate, unticked opt-in per Communications Law s.30A (Section 8). A registered profile without this opt-in receives transactional messages only (order confirmations, custom-cake approval, delivery notices), never loyalty/marketing content.

**Phase recommendation**: loyalty (punch cards, birthday/anniversary sends, promotions) is recommended for **Phase 2**, not MVP, while guest checkout, capacity, delivery settings, and custom cakes stay in MVP as already decided by Ran. Reasoning: loyalty depends on a working registered-customer system, a s.30A-compliant opt-in flow, and a message-sending mechanism (email at minimum) all being correct before the first send, and it adds no revenue-blocking risk if deferred, since MVP already lets every customer order and pay. The registration data model and the opt-in checkbox itself, however, should be built in MVP (US-4) so Phase 2 does not need a migration of existing profiles, only the benefit-sending features on top.

## 7. Phasing

### MVP
- Public catalog with photos, prices, ingredients, allergens (US-1)
- Custom cake requests with manual Yuval approval, pricing, and time-cost setting (US-2)
- Guest checkout (US-3) and optional customer registration, without loyalty features yet (US-4, data model only)
- Delivery/pickup selection with 24h lead time and capacity-driven availability (US-5)
- Delivery zones by city with a flat fee per zone (US-6)
- Delivery list generation for the uncle (US-7)
- Bit/PayBox link-out payment with manual "paid" confirmation and payment-pending expiry (US-8, US-9)
- Web push + email new-order notifications to Yuval (US-10)
- WhatsApp click-to-send from admin (US-11)
- Full self-service content management for Yuval (US-12)
- Resource-based capacity model with DB-level atomic enforcement (Section 4)
- Compliance baseline: s.11 privacy notice, s.14C business details, cancellation-right exemption notice, allergen labeling, admin MFA, Rule 33 public-site baseline (Section 8)

### Phase 2
- Loyalty: punch cards, birthday/anniversary benefit sends, promotions, and the s.30A opt-in-gated send flow (Section 6)
- Automated WhatsApp (Cloud API) replacing click-to-send for transactional notices
- Automated payment confirmation, if/when a Bit/PayBox webhook or API becomes available (currently unverified as existing)
- Uncle-driver read-only "today's deliveries" view (if the shared/printed list proves insufficient in practice)
- Desktop-optimized admin layout (if Yuval reports the responsive mobile layout is insufficient on desktop)
- Customer-facing order status tracking beyond email/push (e.g., an order-history page with live status)

## 8. Compliance Requirements

Carried from rotem's pre-PRD findings in BRIEF.md; binding for MVP unless noted.

- **Privacy notice at collection (Privacy Law s.11)**: shown before/at the point personal data is first collected (checkout, registration), naming what is collected, purpose, and recipients, including **the uncle as a named data recipient** for delivery orders.
- **Marketing opt-in (Communications Law s.30A)**: a separate, unticked checkbox for loyalty/promotional messages, distinct from any required transactional consent; unchecked by default; no loyalty message sent without it (Section 6).
- **Business details (Consumer Protection Law s.14C)**: Yuval's business name, עוסק status/number (pending confirmation, see Section 10), and contact details displayed before payment and in order confirmations.
- **Prices inclusive of VAT and delivery cost shown before payment**: enforced in checkout flow (US-5).
- **Cancellation-right exemption**: perishable/custom-made food is exempt from the standard consumer cancellation right; this exemption must be stated explicitly at checkout and in order confirmation, not merely assumed.
- **Allergen labeling**: every product entry includes an allergen field, populated by Yuval, displayed on every product view (US-1); this is Yuval's own domain content, not validated by the system beyond providing the field.
- **Retention**: a defined retention period for customer data, to be set with Yuval's accountant (open, Section 10); until confirmed, the system must support a configurable retention/deletion policy rather than hardcoding "keep forever."
- **Admin MFA**: Yuval's admin login requires multi-factor authentication, given the PII and payment-adjacent data the admin handles.
- **Rule 33 (public-site baseline)**: this is a public site reachable without login, so it carries the full 18-item baseline at PROD gate, including an accessibility statement, alt text on product photos, AA contrast, keyboard navigation, 44px touch targets, and IS 5568 applicability check (possible small-business exemption, amount to verify before launch).
- **File uploads (inspiration photos)**: treated as untrusted user content; stored privately (not publicly served) until/unless Yuval explicitly promotes an image to the public catalog (US-2 AC).
- **Cyber-IAM scope**: customer authentication (registered profiles) and admin authentication are both in scope for erez's Mode B threat model at BUILD Phase 3, given PII and the admin's operational control over pricing and capacity.

## 9. Non-Goals (MVP)

- In-app card payment or any PCI-scoped payment flow (link-out only).
- Automated WhatsApp messaging (Cloud API), any automated payment confirmation/webhook, and any loyalty automation (Phase 2).
- Multi-kitchen, multi-operator, or multi-tenant support; this is a single-kitchen, single-admin system.
- Native mobile app (this is a PWA, installable from the browser).
- A logged-in view or app for the uncle-driver.
- Inventory/ingredient stock tracking (allergen/ingredient fields are informational labeling, not stock deduction).
- Desktop-only or desktop-optimized admin design pass.

## 10. Open Questions for Yuval

Only items the BRIEF itself left unresolved (BRIEF Section "Open decisions," items 4-7), plus one new item this PRD surfaced while defining the order state machine:

1. **Blackout days / standing working-day pattern**: which days of the week are default working days, and how far in advance should recurring blackout days (e.g., holidays) be set? (BRIEF item 4.)
2. **Business name, domain, and עוסק status/number**: needed to populate s.14C business details and to register a domain/hosting account. (BRIEF item 5.)
3. **Retention period for customer data**: to be set with Yuval's accountant; needed before the privacy notice and retention policy can be finalized. (BRIEF item 6.)
4. **Confirmation of BRIEF item 7**: Ran's assumption that the blank answer #7 referred to the profiles/loyalty and delivery-settings additions already written into the BRIEF, please confirm this reading is correct.
5. **Payment-pending expiry window** (new, raised by this PRD, Section 3.7): the defaults proposed are 4 hours for standard orders and 24 hours for approved custom cakes, before an unpaid order automatically releases its held capacity back to other customers. Please confirm these windows or set your own.

## 11. Success Metrics

- Time from Instagram bio click to completed checkout (guest): target under 3 minutes for a standard (non-custom) order.
- Zero double-booked capacity incidents (oven-minute or work-minute oversell) in production, ever, measured by absence of negative-remaining-capacity rows.
- Percentage of orders Yuval marks `paid` within the payment-pending window (i.e., not expiring): a low expiry rate indicates the window is well-tuned; a high one signals the default needs revisiting with Yuval.
- Percentage of custom-cake requests Yuval reviews (approve or decline) within 24 hours of submission.
- Zero admin actions (catalog change, capacity change, delivery-pricing change) requiring developer involvement post-launch.
- Registered-customer opt-in rate to loyalty messaging, once Phase 2 ships (baseline for evaluating whether loyalty is worth the build).

[[agents/maya]] [[agents/ran]] [[yuval-bakery]]
