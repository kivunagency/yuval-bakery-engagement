---
client: yuval-bakery
adr: ADR-002
title: Capacity ledger, atomic reservation, expiry release
status: accepted
date: 2026-09-25
owner: alex
consulted: dba
---

# ADR-002: Capacity ledger

## The invariant (name it, Rule 17)

**`capacity_never_negative`**: for every `(day, resource)` pair (resource is
`oven_minutes` or `work_minutes`), `reserved <= total`, at every moment,
under any concurrency. amit asserts this directly in tests, not just via
route-level checks: the assertion is "run N concurrent reservation attempts
for the last remaining slot, verify exactly the number that fit succeed and
the rest fail cleanly, verify `reserved` never exceeds `total` at any read
during the race."

## Mechanism

One table, `capacity_day_ledger`, one row per calendar day:

```
day date primary key
oven_minutes_total int not null
oven_minutes_reserved int not null default 0
work_minutes_total int not null
work_minutes_reserved int not null default 0
is_blackout boolean not null default false
check (oven_minutes_reserved >= 0 and oven_minutes_reserved <= oven_minutes_total)
check (work_minutes_reserved >= 0 and work_minutes_reserved <= work_minutes_total)
```

Reservation is a single statement inside the caller's transaction:

```sql
UPDATE capacity_day_ledger
SET oven_minutes_reserved = oven_minutes_reserved + :oven_cost,
    work_minutes_reserved = work_minutes_reserved + :work_cost
WHERE day = :day
  AND oven_minutes_reserved + :oven_cost <= oven_minutes_total
  AND work_minutes_reserved + :work_cost <= work_minutes_total
  AND is_blackout = false
RETURNING day;
```

If this returns zero rows, the reservation failed (insufficient capacity or
blackout day) and the caller rolls back the whole order-creation
transaction, never partially. The `CHECK` constraints are the second,
independent line of defense (belt-and-suspenders): even a caller that
bypasses the conditional `WHERE` (a bug, not a race) cannot write a negative
or over-total row, the transaction aborts instead. This satisfies the
2026-04-20 learned rule on Storage/RLS-adjacent DB correctness in spirit:
never trust a single layer for a money/capacity invariant.

No `SELECT ... FOR UPDATE` + separate `UPDATE` round trip is used
deliberately: a single conditional `UPDATE...WHERE...RETURNING` is
atomic in Postgres without an explicit row lock statement, and is one
fewer round trip under the two-customers-racing-for-the-last-slot scenario
that is this project's actual production risk.

## Release (expiry or cancellation)

Symmetric decrement, also conditional, also floor-checked by the same
`CHECK` constraints:

```sql
UPDATE capacity_day_ledger
SET oven_minutes_reserved = GREATEST(0, oven_minutes_reserved - :oven_cost),
    work_minutes_reserved = GREATEST(0, work_minutes_reserved - :work_cost)
WHERE day = :day;
```
`GREATEST(0, ...)` guards against a double-release (e.g., a retried sweep)
ever taking `reserved` negative, which the `CHECK constraint` would also
catch, so this is belt-and-suspenders again rather than the only guard.

## Custom-cake approval (the cross-context write, see domain-map.md)

`approve()` runs `INSERT INTO orders (...)` and the reservation `UPDATE`
above in the SAME transaction. If the reservation fails (capacity vanished
between when Yuval opened the review screen and when she clicked approve,
because a standard order took the last slot in the meantime), the whole
approve transaction rolls back and the admin UI shows "capacity changed,
re-check before approving" rather than silently overbooking (PRD US-2 AC:
"never a silent overbook").

## Scope note

This is deliberately a single-table ledger, not a per-order-line
reservations table with a SUM query, because the SUM-query pattern is
exactly the race PRD-01 calls out ("two customers checking out for the last
slot on the same day must never both succeed") — a read-then-write of a
derived total has a race window a running total column with a `CHECK`
constraint does not.

[[agents/alex]] [[agents/dba]] [[yuval-bakery/domain-map]]
