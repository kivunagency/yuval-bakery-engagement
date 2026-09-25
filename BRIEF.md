---
client: yuval-bakery
stage: client
type: brief
status: draft
created: 2026-09-25
relationship: family (Ran's cousin), not a paid engagement
---

# YuvalBakery: Brief

Links: [[yuval-bakery]] [[agents/maya]] [[agents/alex]] [[agents/eitan]] [[agents/rotem]]

## Who
Yuval, home pastry chef (קונדיטורית) in Israel: cakes, cookies and more. Markets on Instagram, takes orders today by WhatsApp and phone. Holds a **home food-producer licence** (רישיון יצרן ביתי), confirmed by Ran 2026-09-25.

## What we build
A public ordering PWA (link from Instagram bio) plus an admin area that Yuval uses to run the whole business.

### Customer side (MVP)
- Catalog with photos, prices, ingredients and allergens.
- **Custom cakes are in MVP**: free text (inscription) + inspiration photo upload.
- Pick delivery or pickup, date and time. Lead time: **minimum 24 hours before delivery**.
- Availability shown per day, derived from capacity (below).
- Pay via link out to Yuval's **Bit / PayBox** (no in-app payment). Order number goes in the payment note.

### Yuval's side (MVP)
- **She manages everything in the app**: products, photos, ingredients, allergens, prices, capacity, orders. No developer needed for content.
- Order statuses, manual "paid" marking.
- New-order notification: **in-app (web push) + email**. WhatsApp requested, see open decisions.

### Delivery
Deliveries exist and are performed by **Yuval's uncle**. He needs a delivery list for the day (addresses, times, phones). Privacy: he is a data recipient, name that in the privacy notice.

## Capacity model (decided by Yuval's answer, 2026-09-25)
The daily limit is **oven time and working time**, not a count per item. So capacity is resource-based:
- Each product declares oven minutes and work minutes (per unit or per batch).
- Each day has available oven minutes and work minutes (Yuval sets them; blackout day = 0).
- An order is accepted only if the day still has enough of both. Enforced atomically in the DB, never in app code (two customers racing for the last slot).
- Custom cakes need an estimate of their time cost, or Yuval approves them manually. **Open.**

## Findings already gathered (advisory fan-out 2026-09-25)
- **Stack (alex)**: PWA, not a store app. Next.js + Supabase Postgres (DB-level oversell prevention). Vercel Hobby **forbids commercial use** (verified, vercel.com fair-use page); host on Netlify or Cloudflare free, or pay Vercel Pro. Supabase free **pauses after 7 days without DB activity** (verified); needs a monitored keep-alive or Pro. Off-the-shelf Bakesy ($9.99/mo) exists, Hebrew/RTL and per-resource capacity unverified; custom-cake + oven-time model makes BUY unlikely to fit. Estimate before custom cakes and resource capacity: 6-9 dev-days.
- **Payments (eitan)**: private Bit supports a shareable money-request link with a fixed amount; PayBox has a personal payment link with preset amount. No public webhook/API found for either (UNVERIFIED), so payment is marked manually. Yuval must be registered as עוסק (פטור ceiling 2026: 122,833 ILS) and issue receipts (Morning / Green Invoice).
- **Compliance (rotem)**: privacy notice at collection (s.11), defined retention, admin MFA, separate unticked marketing consent, business details under s.14C, prices incl. VAT and delivery cost before payment, cancellation-right exemption for perishable/custom food stated explicitly, allergens per product, IS 5568 (possible small-business exemption, amount UNVERIFIED). Rule 33 applies (public site).
- **Scope (maya)**: riskiest assumptions: capacity model (now answered), Yuval keeping the app updated (answered: she commits to managing via the app), customers accepting pay-by-link without instant confirmation.

## Decisions, 2026-09-25 (Ran)
- WhatsApp: MVP = click-to-send prefilled message from the admin (free, manual). Automated WhatsApp API is v2.
- Custom cakes: Yuval approves each one manually before payment and sets its price and its time cost on the day.
- **Delivery pricing settings screen** (revised by Ran 2026-09-25): Yuval defines zones, each a city or a group of cities, with a flat fee per zone. Customer picks a city from her list. No distance/geocoding API, so no metered dependency.
- **Customer profiles + loyalty**: customers may register a profile; Yuval can send birthday and anniversary benefits, open punch cards (כרטיסיות הנחה) and run promotions. **Guest checkout must stay available** without registration.
  - Compliance to design in (rotem's Mode A already flagged it): marketing messages need a separate, unticked opt-in (Communications Law s.30A); birthday/anniversary dates are extra PII, optional fields with a stated purpose; customer auth brings cyber-iam into scope.

## Decisions, 2026-09-25 evening (Ran, after phases 1-3)
- All accounts (Netlify, hosted Postgres, Resend, domain) are created under **Yuval's** ownership, not Kivun's org.
- Customer inspiration photos are **never** shown in the public catalog; no promote action.
- Guest checkout: **phone mandatory**, email optional.
- Risk accepted: no managed WAF on Netlify free (low traffic); Cloudflare DNS proxy when a domain exists.
- Timezone for lead time and day boundaries: **Asia/Jerusalem**.
- Still open: who holds the admin second factor and emergency access; written-confirmation channel for a guest with phone only (SMS is metered, Rule 30).

## Open decisions
3. (superseded by the delivery settings screen above)
4. Blackout days / working days.
5. Business name, domain, עוסק status and number.
6. Retention period for customer data (with accountant).
7. Ran's blank answer #7: assumed to be the profiles/loyalty + delivery-settings additions of 2026-09-25; confirm.
