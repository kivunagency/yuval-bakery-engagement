---
client_slug: yuval-bakery
client_name: YuvalBakery (קונדיטוריה ביתית של יובל)
engagement_id: eng-2026-yuval-bakery-001
opened_at: 2026-09-25
opened_by: agency-director
status: active
lifecycle_stage: discovery
stage_entered_at: 2026-09-25T00:00:00Z
stage_history:
  - stage: lead
    entered: 2026-09-25T00:00:00Z
    exited: 2026-09-25T00:00:00Z
contract_end_at: null   # family project, no contract, no fee (Ran's cousin)
tags: [engagement, family-project, no-fee, dept/product, dept/design, dept/engineering, dept/qa, dept/cybersecurity, dept/privacy, dept/finance, agents/agency-director, agents/maya, agents/shir, agents/shir-mobile, agents/alex, agents/dba, agents/dana, agents/jordan, agents/amit, agents/erez, agents/rotem, agents/eitan]
---

# Engagement — YuvalBakery

Family project (Ran's cousin Yuval), no contract, no fee. Treated with the same security/privacy/QA rigor as a paid client; scaled down only on process overhead (see Section 6).

## 1. Summary

Public ordering PWA (from Instagram bio) + admin area for a home food-producer bakery. Custom cakes with photo upload in MVP, resource-based capacity (oven minutes + working minutes per day, enforced atomically in DB), pay-by-link (Bit/PayBox, no card data), delivery by Yuval's uncle, notifications in-app + email. Full context: [[yuval-bakery/BRIEF]].

## 2. Active Departments

**Activated:**
- [[departments/product]] (lead: [[agents/maya]]) — opened 2026-09-25, status: active. Reason: PRD not yet written; BRIEF has 7 open decisions that need resolving into a locked scope before design/build.
- [[departments/design]] (lead: [[agents/shir]], mobile-first via [[agents/shir-mobile]]) — opened 2026-09-25, status: pending PRD. Reason: public-facing ordering PWA, primary usage is Instagram-referred mobile traffic. Desktop pass only if admin screens need it (Yuval likely uses phone/tablet too — confirm in PRD).
- [[departments/engineering]] (lead: [[agents/alex]], + [[agents/dba]], [[agents/dana]], [[agents/jordan]]) — opened 2026-09-25, status: pending PRD. Reason: full build (customer PWA + admin). dba is mandatory pre-jordan because the capacity model MUST be a DB-level atomic constraint (BRIEF: "never in app code — two customers racing for the last slot"), which is a schema/transaction design problem, not application logic.
- [[departments/qa]] (lead: [[agents/amit]]) — opened 2026-09-25, status: pending build. Reason: standard build-pipeline QA gate; Rule 7 regression coverage applies regardless of project size or fee.
- [[departments/cybersecurity]] (lead: [[agents/erez]]) — opened 2026-09-25, status: active (Mode A pre-PRD). **Auto-activated per security rule #3 / departments.json auto_join_triggers**: PII (customer name, phone, address) + public file uploads (inspiration photos) + a public-facing ordering flow are all explicit auto-join triggers. Not optional, not scaled down.
- [[departments/privacy]] (lead: [[agents/rotem]]) — opened 2026-09-25, status: active (Mode A pre-PRD). Reason: customer PII, a named third-party data recipient (the uncle, for delivery), Israeli Privacy Law s.11/s.14C, IS 5568 exposure (Rule 33, public site), retention question open.
- [[departments/finance]] (lead: [[agents/eitan]]) — opened 2026-09-25, status: light/advisory. Reason: pay-by-link model (no PCI scope), עוסק registration status, receipt issuance (Morning/Green Invoice) — advisory only, no bookkeeping/AR ops needed for a project with no billing of its own.

**Explicitly NOT activated, with reasons:**
- **cloud-ops-lead / sre / finops / auto-remediator** — not yet OPERATE stage (Rule 3/6). Revisit at LAUNCH: no SLA, no paying-Kivun-client relationship, but Rule 30 (spend caps + alerts) still applies to Yuval's own hosting/DB accounts the moment they're created — ido/alex own that at BUILD.
- **legal-lead** — no contract between Kivun and Yuval (family, no fee), so no ToS-with-Kivun / DPA-with-Kivun needed. Yuval's own customer-facing ToS and privacy policy are still required (Rule 33) and are owned by rotem, not legal-lead, since there's no Kivun contract to template against. If Yuval ever wants a formal engagement or e-commerce ToS reviewed by counsel, re-open this decision.
- **csm-lead** — activates at LAUNCH per lifecycle dispatch map, not before.
- **marketing (lihi/dor/etc.)** — not requested; Yuval already markets via her own Instagram. Only activate if she later asks for a go-to-market push.
- **noa (psychologist)** — product doesn't touch mental health/kids/habits; not a domain match.
- **telephony-cti / agri-ops / scrap-ops** — no phone-call business event, no agricultural/weighed inventory; not applicable.

## 3. Rule 16 — Domain-Expert Gap Check

**Domain in question**: home food production / bakery order-and-capacity scheduling (oven-time + labor-time resource model, allergen labeling, home food-producer licensing in Israel).

**Finding**: no existing Kivun specialist owns this domain. The closest analogs — `agri-ops` (grown/harvested/cold-chain) and `scrap-ops` (weighed bulk materials) — are both wrong shape: this is neither agricultural nor weighed-bulk, it's small-batch make-to-order production with two scarce resources (oven minutes, labor minutes) consumed per order.

**Decision**: do NOT create a new specialist for this engagement. Reasoning:
- Scope is small (single producer, single kitchen, MVP is a resource-capacity scheduling problem that `alex` + `dba` can model directly as a two-resource daily-ledger table with atomic decrement — this is a standard inventory/capacity pattern, not a domain requiring deep vertical expertise like agri-ops or scrap-ops earn from repeated cross-client patterns).
- The licensing question (רישיון יצרן ביתי) is already answered (Yuval holds it, confirmed by Ran) — no ongoing regulatory-interpretation need.
- Allergen labeling and food-safety content are Yuval's own domain expertise, entered by her in the admin — not something Kivun needs to model or validate beyond giving her the fields.
- **Extension instead**: `alex` treats "oven minutes / work minutes per day" as a generic resource-capacity domain (same shape as a class-booking or equipment-rental capacity problem) rather than food-specific. `rotem` extends her existing food/allergen-adjacent compliance knowledge (already touched allergens + IS 5568 in the BRIEF findings) rather than needing a new agent.
- If Kivun takes on a second food-production client (restaurant, catering, another home producer) and the pattern repeats, that's the trigger to propose a `food-ops` specialist to Ran per `shared/new-specialist-protocol.md` — one data point isn't enough to justify a new agent.

**Gate**: this engagement does not enter BUILD until this section is either reaffirmed at PRD-lock or revisited if scope grows beyond a single-kitchen capacity model.

## 4. Environments

Not yet provisioned — BUILD has not started. Per Rule 6, both DEV and PROD must exist before code lands on `develop`. Per Rule 10 (local-first/free-first) and alex's finding: Vercel Hobby is disallowed for commercial use even though this is unpaid *to Kivun* (Yuval's bakery is itself a commercial business), so hosting must be Netlify/Cloudflare free tier or paid Vercel Pro — decision owned by alex/ido at BUILD kickoff, with Rule 30 spend cap + alert configured the same day any paid tier is provisioned.

```yaml
environments:
  dev:
    url: TBD — provisioned at BUILD kickoff
    branch: develop
    status: not_provisioned
  prod:
    url: TBD — provisioned at BUILD kickoff
    branch: main
    status: not_provisioned
  staging: null
```

## 5. Key Artifacts

- [[yuval-bakery/BRIEF]] — scope, Yuval's answers, advisory fan-out findings (2026-09-25)
- PRD — not yet written (next step, owned by maya)
- design-tokens-mobile.md — not yet written (blocked on PRD)
- tasks.json — not yet written (blocked on PRD + design tokens)
- db/schema.sql (capacity ledger) — not yet written (blocked on PRD; dba owns the resource-capacity + atomic-oversell-prevention design)
- threat-model.md — not yet written (erez Mode B, build-pipeline Phase 3)
- privacy-notice.md / retention-policy.md — not yet written (rotem)

## 6. Cross-Dept Handoffs

- 2026-09-25 | agency-director → maya | STAGE: lead → discovery | trigger: BRIEF.md complete with advisory findings, engagement opened | ref: engagement-schema.md#discovery

## 7. Proportionality — what scales down, what never does

This is a small single-kitchen family app, not an enterprise client. Scaled down:
- **No formal Slack/CRM cadence, no billing/AR ops, no legal-lead contract cycle** — there is no Kivun-Yuval contract.
- **Solo-mode fan-out where the platform is genuinely single-target**: shir-desktop is not dispatched unless the PRD confirms Yuval needs desktop admin screens; dana/jordan can likely run without splitting into dana-mobile-web/dana-desktop given one platform target (mobile-first PWA, admin usable on phone).
- **Docs-on-deploy (Rule 4)** scoped down to a single short Hebrew operation guide for Yuval (how to add a product, set daily capacity, mark an order paid) rather than a full filmed tutorial suite — proportionate to a one-operator business. A short screen-recording is enough; full HyperFrames production is not warranted.
- **cloud-ops full suite** deferred to LAUNCH as noted in Section 2.

**Never cut, regardless of size or fee** (explicit per dispatcher instructions and standing Kivun rules):
- Security (erez Mode A now, Mode B at build-pipeline Phase 3; boaz pen-test before PROD)
- Privacy/compliance (rotem: privacy notice, retention, s.11/s.14C, IS 5568 check, uncle-as-data-recipient disclosure)
- Accessibility (Rule 33 applies in full — this is a public site reachable without login; accessibility statement, alt text, contrast, keyboard nav, 44px targets all required)
- Rule 7 regression coverage and Rule 5 browser-smoke before any "shipped" claim
- Rule 22 QA user handling, Rule 17 proof-of-execution discipline
- DB-level atomic capacity enforcement (not app-level) — this is a correctness requirement, not a nice-to-have, given real money and real ovens

## 8. Phase Plan and Next Step

**Current stage: DISCOVERY.** Next concrete step: dispatch `maya` to convert BRIEF.md into a locked PRD, resolving as many of the 7 open decisions as possible with Yuval directly (via Ran) before QUOTE-equivalent scope lock. **Ran approves this plan before any dispatch happens.**

Phase sequence once approved:
1. **DISCOVERY (now)** — maya writes PRD; erez/rotem/eitan already contributed pre-PRD findings, they review the PRD once drafted.
2. **ONBOARD-equivalent** — no formal onboarding checklist needed (no contract), but before BUILD: hosting account decision (Netlify/Cloudflare/Vercel Pro) and Supabase project creation, since Supabase free pauses after 7 days idle (alex finding) — needs a keep-alive plan or Pro from day one.
3. **BUILD** — shir(-mobile) design tokens → dba schema (capacity ledger first) → alex tasks.json → jordan/dana build → erez Mode B threat model + amit QA + boaz pen-test → deploy-engineer verifies DEV then PROD.
4. **LAUNCH** — short Hebrew operation guide for Yuval, live smoke test, Instagram bio link goes live.
5. **OPERATE** — re-evaluate cloud-ops activation per Rule 3 (does "paying users" apply here? Yuval's customers pay HER via Bit/PayBox, not through Kivun infra — likely still needs baseline monitoring even without formal SLA; agency-director decides at LAUNCH).

**Open decisions from BRIEF.md that block progress, and what they block:**
1. **WhatsApp notifications** (automated Cloud API vs. free click-to-send) — blocks PRD lock (Section: Yuval's side notifications) and, if automated is chosen, blocks eitan/alex from estimating a new paid-API cost line.
2. **Custom-cake capacity** (time estimate vs. manual approval) — blocks dba's capacity-ledger schema design; this is the single riskiest open item since custom cakes are in MVP.
3. **Delivery zones and fees** — blocks PRD checkout flow and rotem's pricing-transparency requirement (prices incl. VAT and delivery cost before payment).
4. **Blackout days / working days** — blocks dba's daily-capacity calendar design (minor, has a sane default: Yuval sets 0 on any blackout day).
5. **Business name, domain, עוסק status and number** — blocks Rule 33 compliance (business details under s.14C) and domain/hosting setup.
6. **Retention period for customer data** — blocks rotem's privacy notice and retention policy, must be resolved with Yuval's accountant per BRIEF.
7. **Ran's blank answer #7** — unresolved, needs Ran to clarify what he meant to add before PRD lock.

Items 1-3 and 7 are PRD-blocking (maya cannot lock scope without them). Items 4-6 can be defaulted or deferred slightly but must close before BUILD Phase 0 (schema + compliance docs).

## 9. Director Notes

- 2026-09-25: Opened at DISCOVERY, not QUOTE/SIGN — this is unpaid family work, so the standard QUOTE→SIGN gate is skipped entirely; PRD lock substitutes for scope agreement. No budget/fee tracking needed in finance dept beyond Yuval's own business advisory (eitan, light).
- 2026-09-25: Rule 16 gap closed by extension (generic resource-capacity modeling + rotem's existing allergen/compliance knowledge), not by new-specialist creation. Revisit only if a second food-production client arrives.
