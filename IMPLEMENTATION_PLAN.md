# RiderHub — Phase 2 Implementation Plan

Working document. Tracks the upgrade spec phase by phase. Update the status marks as
work lands; do not delete completed items — the history is useful.

Status key: `[x]` done and tested · `[~]` in progress · `[ ]` not started

---

## Inventory (spec §57.1–10)

| Question | Answer |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind, Zustand + TanStack Query |
| Backend | Node + Express + TypeScript, Socket.IO for live rides |
| Database | Cloud Firestore (schemaless — additive changes need no migration) |
| Auth | Firebase Auth, ID token verified on every request and socket handshake |
| Existing APIs | users, bikes, groups, fuel, services, documents, reminders, analytics, sos |
| Map | MapLibre GL JS + OpenFreeMap tiles (no key, no quota) |
| Fuel | Full CRUD + stats; entry bug fixed (see Phase 0) |
| Rides | Live tracking only — no ride records, types, stops or history |
| Garage | Bike CRUD; no detail screen, no parts lifecycle |

**Data safety.** Firestore is schemaless and every change below is *additive* — new
collections and new optional fields. No existing document is rewritten or dropped, so no
backup/migration step is required. Where a field gains meaning (e.g. `service_number`),
existing records simply read as `null` until edited.

---

## Phase 0 — Critical bug fixes (spec §45)

- [x] Fuel entry submission — root cause was missing composite indexes breaking `GET /bikes`,
      which left the bike dropdown empty, which made the form's guard clause discard the
      submission silently
- [x] Remove all composite-index dependencies — equality-only queries + in-memory sort, so
      the app cannot break from an undeployed index again
- [x] Fuel API verified end-to-end (create → persist → read back → stats)
- [x] Fuel form: per-field validation messages, no silent failures
- [x] Newest fuel entry first
- [x] Month / year / all-time fuel filter with per-period totals
- [x] Map: guaranteed sizing, resize observer, WebGL probe, tile-error surface, retry
- [x] `GET /groups/:id` added — direct map load no longer blanks the header
- [x] Global selected-bike state, persisted across reloads
- [ ] Confirm map renders on the rider's device (needs the on-screen error text if still blank)

## Phase 1 — Core data integrity (spec §27, §28, §29)

- [x] Ownership enforced server-side on every read and write (`user_id` filter + `getOwned`)
- [x] Odometer monotonic — never lowered by a back-dated entry
- [x] Deleting a bike cascades to fuel, services, maintenance and reminders; documents are
      unlinked rather than deleted (a licence outlives a bike)
- [x] Backend validation parity on every new endpoint (zod)
- [x] Bike-ownership checked on every bike-scoped route, verified by IDOR tests
- [x] Service totals computed server-side from labour + parts + tax + other, never trusted
      from the client

## Phase 2 — Garage + multi-bike (spec §3.1, §5, §6, §27, §46)

- [x] Selected bike persisted globally
- [x] Bike name + switcher centred in the header; one bike shows a label, two or more a picker
- [x] Switching re-scopes every screen; isolation verified by test
- [x] Bike cards: odometer, real mileage, last service, next service, maintenance health badge
- [x] Bike detail dashboard with lifetime stats and the maintenance grid
- [ ] Bike photo (needs the attachments decision)

## Phase 3 — Maintenance engine (spec §7, §24, §25, §47)

Backend complete and tested (49 checks). UI still to build.

- [x] Component model with dual triggers (date + odometer, whichever falls first)
- [x] Status engine: healthy / due soon / due / overdue / unknown; thresholds in one
      exported constant (`THRESHOLDS` in `backend/src/lib/maintenance.ts`)
- [x] 20 default components seeded per bike on first open, clocks set from current odometer
      so nothing reads as instantly overdue
- [x] Custom rider-defined components; rejected if given no interval at all
- [x] Mark-replaced resets both clocks
- [x] Status returned as text label + km remaining + days remaining + progress, so colour
      is never the only signal (§7.3, §40)
- [x] Service → maintenance automation by keyword match; longest keyword wins so
      "oil filter" is not swallowed by "engine oil" (§25)
- [x] Maintenance UI: tiles shaded by urgency, grouped by category, with a
      needs-attention filter and a tap-through detail sheet
- [x] Mark-replaced from the UI, at the bike's current reading
- [x] Add and remove rider-defined components from the UI

## Phase 4 — Service (spec §8, §25, §48)

- [x] Service dashboard: SL, service number, date, odometer, centre, cost, parts count,
      plus a count / total / average summary strip
- [x] Service detail screen with itemised cost breakdown and full parts list
- [x] Create with running total shown as you type; server owns the arithmetic
- [x] Edit (`PUT /services/:id`) and delete, both ownership-checked
- [x] Saving a service auto-updates matching maintenance and reports what it changed
- [x] Extra fields: service number, advisor, part number, warranty months
- [ ] Invoice attachment (needs the attachments decision)

## Phase 6 — Home dashboard (spec §4, §50)

- [x] Bike-scoped headline gauges: total distance, mileage, last service, next service
- [x] Cost panel with month / year / all-time and a proportional fuel-vs-service bar
- [x] Upcoming maintenance list, tap through to the component
- [x] Fuel range estimate from tank size × real mileage
- [x] Skeleton loaders, error state with retry, empty state
- [ ] Trend charts (mileage over time, monthly spend)

## Phase 5 — Fuel + mileage (spec §9, §10, §49)

- [x] Add fuel works; validation; newest first; period filters
- [ ] Edit and delete a fuel entry
- [ ] Full-tank-to-full-tank mileage, partial fills excluded correctly
- [ ] Outlier and duplicate detection
- [ ] "Not enough data yet" indicator instead of a misleading number

## Phase 6 — Home dashboard (spec §4, §50)

- [ ] Bike-scoped headline stats
- [ ] Cost panel with month / year / all-time
- [ ] Upcoming maintenance list, tap through to detail
- [ ] Infographic layout, mobile-first

## Phase 7 — Map (spec §14, §53)

- [x] Error state instead of a blank screen
- [ ] Current-location marker with accuracy
- [ ] Route and stop rendering

## Phase 8 — Solo ride (spec §11, §12, §13, §15, §51)

Backend and screens complete, 47 checks. Live navigation on the map is the remaining piece.

- [x] Ride records: name, bike, type (solo/duo/group), status, stops, notes
- [x] Ride dashboard — SL, name, bike, type, status, date, distance, stop count; status
      filter; resume banner for a ride already in progress
- [x] Ride detail with distance, duration (excluding paused time), average and top speed,
      mileage, fuel and other cost, cost per km, and a vertical route timeline
- [x] Stops: add, remove, reorder, mark reached; reorder rejects a partial list
- [x] Status lifecycle enforced server-side — illegal transitions return 409, not a
      silently-applied state
- [x] Completion captures closing odometer, fuel and costs; distance comes from the
      odometer so it survives GPS dropout; rejects a closing reading below the opening
- [x] Completing a ride advances the bike's odometer
- [x] GPS trail accepted in batches (one document per batch, not per fix) with top speed
      derived; deleting a ride deletes its trail
- [x] Live navigation: road route drawn on the map, distance / ETA / bearing to the next
      stop, route progress, auto-advance on arrival, voice guidance, wake lock,
      batched GPS upload with a retry buffer
- [x] Add a stop mid-ride without leaving the map — search a place, or "Stop here" to pin
      the rider's current position. Choose *next* (detour now) or *last* (before the
      finish). A stop already reached is never displaced.
- [x] Itinerary panel: every remaining stop with its own cumulative distance and ETA,
      from a single routing call that returns per-leg totals rather than one call per stop
- [x] Fuel logged during a ride counts toward that ride (spec §21). One entry appears in
      both the bike's lifetime totals and the ride's cost and mileage — no double entry
      and no double counting. Completion pre-fills from it; manual figures override.
- [x] The map draws the **whole remaining journey** — current position through every
      unreached stop to the final destination. The leg being ridden is bright; the rest is
      dimmed. One routing call returns per-leg geometry, so showing the full path costs
      no more than showing the next hop did.
- [x] Turn-by-turn navigation mode: full-width manoeuvre banner with an arrow per Google
      manoeuvre code and distance to the turn, tilted heading-up camera, spoken guidance
      at ~300 m and again at the turn, floating recentre button, and a compact bar with
      ETA, distance remaining, arrival clock and current speed.

**Vector map requirement.** Google only allows programmatic tilt and heading on *vector*
maps, which need a Map ID; on a raster map `setHeading()` silently does nothing. Set
`VITE_GOOGLE_MAPS_MAP_ID` to get heading-up navigation. Without it everything still works,
just north-up and flat. A vector map also ignores inline styles, so the dark theme moves
to the cloud console — which is why both paths are supported rather than forcing one.

### Map, routing and place-search provider — all Google

Superseded the earlier OpenRouteService decision, for two reasons.

**Licensing forced the issue.** Google's terms state *"Customer will not use Google Maps
Content from the Directions API in conjunction with a non-Google map"*, and the same
clause covers Places. Google Places on a MapLibre basemap was a breach. It has to be
all-Google or all-open — mixing is not permitted.

**At 10 riders the cost argument disappeared.** Google's tiers are per-month where
ORS is per-day, which mattered at 100 riders but not at 10:

| Service | Usage at 10 riders | Free tier |
|---|---|---|
| Dynamic Maps (map loads) | ~200 / month | 10,000 |
| Routes API (traffic-aware) | ~720 / month | 5,000 (Advanced) |
| Place Details | ~240 / month | 10,000 |

**What was given up:** offline map tiles. Google serves tiles at runtime and its terms
forbid caching them, so in a dead zone the map will not draw. GPS, distance, bearing,
stop list and the recorded track all keep working — only the basemap is lost. This
knowingly trades away spec §32.

**Ceiling to watch:** 10,000 map loads/month is roughly 50 riders at this usage pattern.
Past that, revisit.

Quota protection: routes cached server-side for 5 minutes (short, because traffic-aware
ETAs go stale) keyed on coordinates rounded to ~11 m, computed once per leg, and
recalculated only when the rider strays more than 250 m off the line.

Keys: `GOOGLE_MAPS_API_KEY` server-side (Routes + Places), `VITE_GOOGLE_MAPS_API_KEY`
in the browser for the JS API. **Restrict the browser key by HTTP referrer** — an
unrestricted Maps key is the usual way people end up paying for someone else's traffic.

### Place search provider decision

Navigation is only as good as its waypoints, and a stop typed as free text has no
position to route to. Place search is therefore part of navigation, not a nicety.

| | Free allowance | Card | Indian coverage |
|---|---|---|---|
| **Google Places (New)** | Autocomplete session free; **10,000 Place Details / month** (Essentials) | Yes | Excellent |
| Photon (komoot, OSM) | Fair use, no published cap | No | Patchy for Indian POIs |
| Nominatim | 1 req/sec | No | **Rejected** — its policy forbids autocomplete-style use |

Google is used when `GOOGLE_MAPS_API_KEY` is set, with Photon as an automatic fallback if
it is absent or erroring. This is the one place Google genuinely beats the free option,
because Indian address and POI coverage in OSM is thin.

Cost control: one session token per picker interaction (autocomplete keystrokes are free
within a session), a 350 ms debounce so a typed word is one request rather than eight, and
a Place Details field mask limited to `id,displayName,formattedAddress,location` — adding
richer fields would move the call to a paid SKU.

## Phase 9 — Duo / group ride (spec §17, §18, §19, §52)

- [x] Group creation, invite code, join, leave, live markers
- [ ] Roles: leader / co-leader / member
- [ ] Hide/show other riders' markers
- [ ] Location sharing stops on ride completion, explicitly

## Phase 10 — Offline / GPS resilience (spec §16, §31, §32)

- [ ] Local GPS buffer, retry queue, sync state indicator
- [ ] Ride survives backgrounding and network loss

## Phase 11 — Safety (spec §20)

- [ ] Pre-ride checklist (skippable)
- [ ] Emergency menu
- [ ] Reminder notifications actually send (no scheduler exists today)

## Phase 12 — Analytics + expenses (spec §21, §22, §23, §26)

- [ ] Expense system with categories
- [ ] Ride cost roll-up
- [ ] Analytics dashboard with filters

## Phase 13 — Performance + security (spec §30, §41, §42)

- [ ] Pagination and lazy loading on long lists
- [ ] Rolling totals so the dashboard stops scanning full history
- [ ] IDOR sweep across every new endpoint
- [ ] GPS retention and sharing review

---

## Decisions still needed from the rider

1. **Ride GPS recording.** Ride distance, fuel used and mileage per ride require storing the
   route. Today positions are memory-only, which is why the app is free to run. Recording a
   point every 30–60s for 100 riders is affordable but is a change of position.
2. **Attachments.** §8.3 and §37 want invoices and photos. Firebase Storage needs a paid
   plan, so this needs either a free host or a link-only field.
