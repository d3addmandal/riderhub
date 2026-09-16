## Rider Group Tracking Platform – Final MVP Architecture

### Objective

A web-based rider tracking platform where:

* Riders create riding groups.
* Riders invite or add members.
* A destination is selected.
* Every rider opens the web app on their phone.
* The application continuously shares GPS coordinates.
* All riders are displayed as colored markers on a live map.
* Riders can monitor each other's location in real time throughout the ride.

---

# Architecture Overview

```text
┌─────────────────────────────┐
│          Cloudflare         │
│      DNS + SSL + CDN        │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│           Vercel            │
│      React PWA Frontend     │
└─────────────┬───────────────┘
              │ HTTPS
              ▼
┌─────────────────────────────┐
│       AWS EC2 Free Tier     │
│                             │
│  Node.js + Express          │
│  Socket.IO Server           │
│  Group Management API       │
│  Rider Tracking Engine      │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│        Firebase Free        │
│                             │
│ Cloud Firestore             │
│ Firebase Authentication     │
│ (no Cloud Storage — Spark)  │
└─────────────────────────────┘

              │
              ▼

┌─────────────────────────────┐
│  MapLibre GL + OpenFreeMap  │
│                             │
│ OpenStreetMap vector tiles  │
│ Marker Rendering            │
│ No API key · no usage cap   │
└─────────────────────────────┘
```

---

# Technology Stack

| Component        | Technology            |
| ---------------- | --------------------- |
| Frontend         | React + TypeScript    |
| Mobile Support   | PWA                   |
| Maps             | MapLibre GL JS + OpenFreeMap (OSM) |
| Authentication   | Firebase Auth         |
| Backend API      | Node.js + Express     |
| Real-Time Engine | Socket.IO             |
| Database         | Cloud Firestore       |
| File Storage     | None — see note below |
| Hosting          | Vercel                |
| VPS              | AWS EC2 Free Tier     |
| SSL              | Cloudflare            |
| Monitoring       | UptimeRobot           |
| Notifications    | Telegram Bot          |

---

# Database Design

Cloud Firestore. Document IDs are Firestore auto-IDs unless stated; timestamps are stored
as ISO-8601 strings and dates as `YYYY-MM-DD`, so they sort lexicographically.

The full model — including garage, fuel, service, documents and reminders — lives in
`FIRESTORE_MODEL.md`. The ride-tracking core is below.

## Profiles

```text
profiles/{uid}
```

| Field      | Type   |
| ---------- | ------ |
| *(doc ID)* | Firebase UID |
| name       | string |
| email      | string |
| avatar_url | string |
| created_at | string (ISO) |

---

## Ride Groups

```text
rideGroups/{groupId}
```

| Field            | Type   |
| ---------------- | ------ |
| name             | string |
| owner_id         | string (UID) |
| invite_code      | string (6 hex chars) |
| destination_name | string |
| destination_lat  | number |
| destination_lng  | number |
| status           | 'active' \| 'ended' |
| created_at       | string (ISO) |

---

## Group Members

```text
rideGroups/{groupId}/members/{uid}
```

Subcollection keyed by rider UID, so membership checks are a single document read.
A rider's own groups come from a collection-group query on `members`.

| Field      | Type   |
| ---------- | ------ |
| *(doc ID)* | rider UID |
| group_id   | string |
| user_id    | string (UID) |
| color_code | string |
| role       | 'admin' \| 'member' |
| joined_at  | string (ISO) |

---

## Active Ride

There is no separate `active_rides` collection. A group *is* the ride: `status` on
`rideGroups` carries `active` / `ended`, with `ended_at` written when the owner ends it.

---

## Ride History

Live positions are held in server memory (see Performance Strategy) and are not currently
persisted. When ride replay lands in V2, a `rideGroups/{groupId}/locations` subcollection
holding batched points is the intended home:

| Field     | Type   |
| --------- | ------ |
| user_id   | string (UID) |
| latitude  | number |
| longitude | number |
| speed     | number |
| heading   | number |
| timestamp | string (ISO) |

---

# Authentication Flow

### Login Options

* Google Login
* Email magic link (passwordless)

Managed through:

[Firebase Authentication](https://firebase.google.com/docs/auth)

No password management required.

> Firebase has no "6-digit code to email" flow. Email sign-in uses
> `sendSignInLinkToEmail`, and the rider is signed in by opening the link.

---

# Real-Time Tracking Engine

## Rider Location Update

Mobile Browser:

```javascript
navigator.geolocation.watchPosition()
```

Updates sent:

```text
Every 5 seconds
OR
Movement > 15 meters
```

---

## Socket.IO Rooms

Each group becomes a room.

```text
group-123
group-456
group-789
```

Example:

```text
Group A
├─ Rider 1
├─ Rider 2
├─ Rider 3
└─ Rider 4

Socket Room:
group-a
```

Only group members receive updates.

---

# Live Map Features

### Rider Marker

Each rider gets:

```text
Unique Color
Name Label
Speed
Last Seen
```

Example:

```text
Red Marker     → John
Blue Marker    → Alex
Green Marker   → David
Yellow Marker  → Sarah
```

---

### Destination Marker

Displayed for all riders.

```text
Destination:
Leh Ladakh
```

The destination is shown as a pin. No turn-by-turn route line is drawn today — riders
navigate by the shared pin. If routing is wanted later, OpenRouteService, GraphHopper or a
self-hosted Valhalla all have free tiers and return GeoJSON that MapLibre can draw
directly as a line layer.

---

### Rider Status

```text
🟢 Moving
🟡 Idle
🔴 Offline
```

Offline detection:

```text
No update > 30 seconds
```

---

# Telegram Integration

### Group Created

```text
New Ride Group Created

Group:
Weekend Ride

Created By:
Dipanjan
```

---

### SOS Trigger

```text
EMERGENCY ALERT

Rider:
John

Latitude:
22.5726

Longitude:
88.3639

Open Map:
Google Maps Link
```

---

### Ride Started

```text
Ride Started

Group:
Weekend Ride

Members:
8
```

---

# Security Controls

### JWT Authentication

Firebase ID token verification on the backend via `admin.auth().verifyIdToken()`.

Note that the Admin SDK bypasses Firestore rules entirely, so the API enforces
ownership in code (`user_id` filters plus `getOwned`/`deleteOwned`). The rules files guard
direct client access only.

---

### Socket Authentication

Every WebSocket connection:

```text
JWT Validation
Group Membership Validation
```

---

### Rate Limiting

Use:

```text
express-rate-limit
```

Protects:

* Login
* Group creation
* Invitations

---

### Security Headers

Cloudflare + Backend:

```text
CSP
HSTS
X-Frame-Options
Referrer-Policy
Permissions-Policy
```

---

# Performance Strategy

### Do NOT Write Every GPS Update to Database

Bad:

```text
GPS
→ DB
→ GPS
→ DB
→ GPS
→ DB
```

---

### Recommended

Live:

```text
GPS
→ Socket.IO
→ Memory Cache
```

Historical:

```text
Every 30–60 seconds
→ Batch Write
→ Firestore
```

This dramatically reduces database usage — and with Firestore billing per document write,
it is the difference between a free tier and a bill.

---

# Free-Tier Resource Utilization

### Vercel

* React frontend
* Static assets

Cost: ₹0

---

### AWS EC2 Free Tier

* Node.js API
* Socket.IO server

Cost: ₹0

---

### Firebase

* Authentication
* Cloud Firestore

Cost: ₹0 on the Spark plan — no billing account, no card.

**Cloud Storage is deliberately not used.** Since 3 February 2026 it requires the paid
Blaze plan; Spark projects get 402/403 on every bucket call, with no workaround. Rather
than take on a billing account, the documents vault stores paperwork *expiry metadata*
(type, issuer, policy number, expiry date) and warns before things lapse. Riders keep the
actual PDF wherever they already keep it.

Spark quotas to watch as the club grows: 1 GiB stored, 50k document reads/day and
20k writes/day. See the note in `FIRESTORE_MODEL.md` about the dashboard's read cost.

---

### MapLibre GL JS + OpenFreeMap

* Vector basemap (OpenStreetMap data)
* Marker rendering

Cost: ₹0 — permanently, not "within free-tier limits". MapLibre is open source and ships
in the app bundle; OpenFreeMap's public instance has no key, no registration and no cap on
views or requests.

Chosen over Mapbox (50k loads/month free) and Google Maps (10k loads/month free since the
$200 credit was retired in March 2025) because neither has a limit that stays free
by definition as the club grows.

---

### Cloudflare

* DNS
* SSL
* CDN
* DDoS protection

Cost: ₹0

---

# Future Version 2 Features

* Ride replay
* Voice communication
* Crash detection
* Geofencing alerts
* Fuel stop recommendations
* Nearby rider discovery
* Android/iOS app using React Native
* Offline map caching
* Route sharing
* Public ride events

This architecture is realistic, fully deployable on free tiers, and suitable for an MVP supporting roughly 100–300 concurrently active riders with real-time location updates.
