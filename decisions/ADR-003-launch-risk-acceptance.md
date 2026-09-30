---
client: yuval-bakery
adr: ADR-003
title: Launch risk acceptance, no WAF or Turnstile, single admin TOTP factor with break-glass
status: accepted
date: 2026-09-30
owner: Ran
consulted: boaz (security baseline gate 2026-09-30), deploy-engineer
---

# ADR-003: Launch risk acceptance

Two blockers from the security baseline gate (`cybersec/security-baseline-gate-2026-09-30.md`,
blockers 4 and 5) are decisions, not code. Ran accepted both on 2026-09-30, in writing in the
session chat ("מאשר את 4 ו-5 לפי ההמלצה"), for the first PROD launch.

## 1. No WAF and no Turnstile at launch (SEC-022, SEC-005 layer 1)

**Decision:** launch without a web application firewall and without Cloudflare Turnstile on
`POST /api/orders` and the other public write endpoints.

**Why this is acceptable now:** a home bakery with a handful of orders a day and no payment data
on the site (payment is a link out to Bit or PayBox). The abuse that matters is order spam that
holds oven time, and it is already limited in the database, where it cannot be skipped:

- 3 orders per IP per hour, 2 open unpaid orders per phone (`fn_create_standard_order`)
- one order at most 35% of a day's capacity, unpaid holds at most 70% (SEC-005)
- unpaid orders expire and release their minutes (`expire-orders`, 4 hours for standard orders)
- Yuval can release a day's unpaid holds in one action (`/api/admin/orders/release-unpaid`)
- admin login rate limit fails closed; admin requires TOTP (aal2)
- Netlify Free has no auto upgrade, so a flood is an outage, not a bill (Rule 30 alert still required)

**Known gaps accepted:** the per-IP limit trusts `x-nf-client-connection-ip`, which is set by
Netlify but not verified by us (gate finding O2); `POST /api/checkout/fit` has no rate limit of
its own (O3). Both are LOW or MEDIUM for this traffic.

**Revisit when any of these happens:** a spam or bot incident; more than about 30 orders a day;
a custom domain moves traffic behind Cloudflare (then Turnstile is a small change); payment is
taken on the site.

## 2. One admin TOTP factor, no second factor at launch (SEC-012)

**Decision:** Yuval launches with one TOTP factor (her phone). The threat model section 3.4 asks
for two factors registered in advance; that is deferred.

**Break-glass procedure (the recovery path), from threat model section 3.4:**

1. Yuval reports that her phone (and the authenticator app) is lost.
2. Ran verifies her identity on a video call. No reset on a text message or an email alone.
3. Ran, as a member of Yuval's Supabase organisation, removes her TOTP factor: Supabase dashboard,
   Authentication, Users, her user, delete the MFA factor (or the Auth admin API). Nothing else on
   her account changes.
4. At her next sign-in she scans a new QR code; `admins.mfa_enrolled_at` updates.
5. Ran records the reset (date, reason, who verified) in `cybersec/` and emails Yuval that it happened.
   An email about a reset she did not ask for means she calls Ran at once.

**Accepted risk:** until a second factor exists, a lost phone means Yuval cannot reach the admin
until Ran performs the steps above. Orders keep arriving; nothing on the public site depends on
the admin being signed in.

**Revisit when:** Yuval has a second device (a tablet at home) or is willing to keep a printed QR
code in a sealed envelope; at that point enrolling the second factor is a few minutes and
supersedes this section.

## Consequences

- Gate blockers 4 and 5 are closed by this ADR. Blockers 1 and 2 were fixed in PR #64 and verified
  on live DEV (HttpOnly, Secure, SameSite=Lax, Max-Age=43200; 31 minutes idle returns to login).
  Blocker 3 (PROD Auth settings) stays open until the PROD project is configured and read back.
- `threat-model.md` is unchanged; this ADR records the deviation from SEC-012 and SEC-022.
