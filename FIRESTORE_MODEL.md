# RiderHub — Firestore Data Model

The complete data model. Firestore is the only datastore in this project.

Field names are `snake_case`, carried over so the React pages and
`frontend/src/types/index.ts` needed no changes during the migration.

## Collections

| Collection | Doc ID | Owner field | Notes |
|---|---|---|---|
| `profiles` | Firebase UID | *(the doc ID)* | Created automatically on first `GET /api/users/me` |
| `motorcycles` | auto | `user_id` | |
| `fuelEntries` | auto | `user_id` | Also carries `motorcycle_id` |
| `serviceRecords` | auto | `user_id` | `service_parts` embedded as an array |
| `documents` | auto | `user_id` | Expiry metadata only — no files are stored |
| `reminders` | auto | `user_id` | Soft-deleted via `is_active: false` |
| `expenses` | auto | `user_id` | Reserved for Phase 2; rules in place, no route yet |
| `sosEvents` | auto | `user_id` | Append-only |
| `rideGroups` | auto | `owner_id` | |
| `rideGroups/{id}/members` | rider UID | `user_id` | Subcollection, one doc per rider |

## Design decisions

**Service parts are embedded, not a collection.** Parts only ever belong to one service
record and are always read alongside it, so they live on the parent document as
`service_parts: [{ id, part_name, brand, cost, quantity }]` — one read instead of two.

**Group members are a subcollection keyed by UID.** `rideGroups/{id}/members/{uid}` makes
"is this rider in this group?" a single document read. Finding a rider's own groups uses a
**collection-group query** on `members` filtered by `user_id`.

**Joins are hydrated in memory.** Firestore has no joins, and the UI expects a
`motorcycles: { brand, model }` sub-object on fuel, service, document and reminder rows.
Each route loads the rider's bikes once via `bikeMap()` — a rider has a handful at most —
and attaches it. See `backend/src/lib/firestore.ts`.

**Odometer updates go through a transaction.** `bumpOdometer()` raises a bike's reading
when a fuel or service entry reports a higher one, and never lowers it — so a
back-dated or mistyped entry cannot rewind the odometer.

**Dates are strings, not Firestore `Timestamp`.** `YYYY-MM-DD` for dates, ISO-8601 for
timestamps. They sort lexicographically, so `orderBy` behaves, and date comparisons work
directly in both the API and the frontend (`f.date >= startOfMonth`).

**IDs are Firestore auto-IDs** — 20-character alphanumerics, so ID validators are
`z.string().min(1)` rather than a UUID check.

## Authorization

Two independent layers:

1. **`firestore.rules`** — governs direct client access. In practice the frontend never
   talks to Firestore directly; every read and write goes through the API. The rules are a
   backstop in case that changes.
2. **The Express API** — runs on the Admin SDK, which *bypasses rules entirely*. Ownership
   is enforced in code: every read filters `where('user_id', '==', req.user.id)` and every
   single-document route goes through `getOwned()` / `deleteOwned()`.

Layer 2 is the one that matters for the app's own traffic — the rules files cannot protect
anything the API does. Any new route must filter by `user_id` or go through
`getOwned()`/`deleteOwned()`; forgetting to is the way a rider's data leaks.

## Free-tier read budget (watch this one)

The Spark plan allows **50,000 document reads per day** across the whole project.

`GET /api/analytics/dashboard` is the app's home screen and it reads a rider's *entire*
history each time — all fuel entries, all service records, all documents, all active
reminders — to compute totals. That is roughly:

```
reads per dashboard load ≈ bikes + fuel entries + service records + documents + reminders
```

A rider one year in (≈50 fuel entries) costs about **70 reads per load**. At 100 riders
opening the app 3× a day that is ~21,000 reads/day — comfortably inside the quota.

It does not stay comfortable. The cost grows with each rider's accumulated history, so at
~150 fuel entries each and 5 opens a day it crosses 50,000 and the app starts returning
errors until midnight Pacific.

**The fix when that day comes:** keep running totals on a `stats/{uid}` document updated
when fuel and service entries are written, and have the dashboard read that one document
instead of scanning collections. That turns ~70 reads into 1. It is a contained change to
`analytics.ts` plus the write paths in `fuel.ts` and `services.ts` — worth doing before the
club grows much past 100 riders, not before.

## Indexes

`firestore.indexes.json` holds 13 composite indexes. Deploy them before first use:

```bash
firebase deploy --only firestore:indexes
```

Any query Firestore cannot serve fails with an error containing a console link that
creates the missing index — if you add a new filter + sort combination, that link is the
fastest path.
