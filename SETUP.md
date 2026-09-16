# RiderHub — Setup Guide

## Quick path

```bash
npm run install:all    # install backend + frontend dependencies
npm run setup          # interactive — writes both .env files from your Firebase creds
npm run doctor         # verifies everything, including a live Firebase connection
npm run deploy:rules   # push firestore.rules and indexes
npm run dev            # start API + web together
```

`npm run doctor` is the one to remember — when something is broken it names the exact
cause and the fix. The console steps it cannot do for you are in section 1 below.

---

## Prerequisites
- Node.js 18+
- Firebase project (the free **Spark** plan is enough — no billing account needed)
- Telegram Bot (optional, for SOS/reminders)
- Firebase CLI: `npm install -g firebase-tools`

Maps need **no account and no API key** — see section 2.

---

## 1. Firebase Setup

### 1.1 Create the project
1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. **Build → Authentication → Get started**, then enable two sign-in providers:
   - **Google**
   - **Email/Password** → expand it and turn on **Email link (passwordless sign-in)**
3. Under **Authentication → Settings → Authorized domains**, add `localhost` (already there
   by default) and your production domain.

### 1.2 Firestore
1. **Build → Firestore Database → Create database** → production mode, pick a region
   (`asia-south1` for India).
2. Do *not* hand-write rules in the console — they are deployed from this repo in step 1.5.

### 1.3 Storage — skip it
Cloud Storage is **not used**. Since 3 Feb 2026 it requires the paid Blaze plan, so the
documents vault tracks expiry dates instead of storing files. Nothing to enable here.

### 1.4 Credentials
- **Web config** (frontend): Project Settings → General → Your apps → Web app → SDK setup
  and configuration. Copy `apiKey`, `authDomain`, `projectId`, `messagingSenderId`
  and `appId`. (`storageBucket` is not needed.)
- **Service account** (backend): Project Settings → Service accounts → **Generate new
  private key**. From the downloaded JSON copy `project_id`, `client_email` and
  `private_key`.

  > Keep `private_key` wrapped in double quotes in `.env` with its `\n` escapes intact —
  > the backend converts them back to newlines.

### 1.5 Deploy rules and indexes

```bash
firebase login
firebase use --add          # select your project
firebase deploy --only firestore:rules,firestore:indexes
```

The 13 composite indexes take a few minutes to build. Queries fail until they are ready.

---

## 2. Maps — nothing to set up

The live map uses **MapLibre GL JS** (open source, bundled via npm) rendering
**OpenFreeMap** vector tiles. No account, no API key, no credit card, and no request cap.

Style in use: `https://tiles.openfreemap.org/styles/dark` — set as `MAP_STYLE` at the top
of [frontend/src/pages/LiveMapPage.tsx](frontend/src/pages/LiveMapPage.tsx). Swap it for
`liberty`, `positron`, `bright` or `fiord` if you prefer a different look.

Two things worth knowing:

- **Attribution is required.** OpenStreetMap's licence requires visible credit, so the map
  renders a compact `(i)` attribution control. Don't remove it.
- **No SLA.** OpenFreeMap is donation-funded. For a club of ~100 riders that is fine, and
  the tile stack is open source if you ever want to self-host. Tiles are also cached by the
  service worker for 30 days, so a brief outage does not blank the map for areas already
  ridden.

---

## 3. Backend Setup

```bash
cd backend
cp .env.example .env
# Fill in your .env values

npm install
npm run dev
```

Backend runs on `http://localhost:3001`

### .env values needed:
```
PORT=3001
FIREBASE_PROJECT_ID=your-project
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
FRONTEND_URL=http://localhost:5173
TELEGRAM_BOT_TOKEN=123456:ABC...  (optional)
```

---

## 4. Frontend Setup

```bash
cd frontend
cp .env.example .env
# Fill in your .env values

npm install
npm run dev
```

Frontend runs on `http://localhost:5173`

### .env values needed:
```
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef
VITE_API_URL=http://localhost:3001
```

> The Firebase web API key is not a secret — it identifies the project, it does not grant
> access. Security comes from Auth plus firestore.rules.

---

## 5. Telegram Bot (Optional, but it is what makes SOS actually work)

Without this, pressing SOS records the event and notifies **nobody**.

### 5.1 Create the bot — once, by you
1. Open [@BotFather](https://t.me/BotFather) → send `/newbot`
2. Give it a display name, then a username ending in `bot` (e.g. `FlyWithPegasusBot`)
3. Copy the token it gives you into `backend/.env`:
   ```
   TELEGRAM_BOT_TOKEN=8956763339:AAG...
   ```
4. Verify and print the bot's username:
   ```bash
   npm run telegram
   ```
5. Put that username (without the `@`) in `frontend/.env` so the in-app instructions
   point riders at the right bot:
   ```
   VITE_TELEGRAM_BOT_USERNAME=FlyWithPegasusBot
   ```

### 5.2 Each rider — 30 seconds
1. Open your club bot in Telegram and press **Start**.
   **This step is mandatory.** Telegram forbids a bot from messaging someone who has
   never started it; skip it and sends fail with *"bot can't initiate conversation"*.
2. Open [@userinfobot](https://t.me/userinfobot) — it replies with their numeric ID.
3. Paste that number into RiderHub → **Profile → Telegram Chat ID** → Save.

> RiderHub's bot only ever *sends*. It has no polling or webhook handler, so messaging it
> gets no reply — that is expected, and why riders get their ID from `@userinfobot`.

### 5.3 Better for a club: one group chat
Instead of collecting 100 individual IDs, put everyone in one Telegram group:

1. Create the group and add your bot to it
2. Send any message in the group
3. Run `npm run telegram` — the group's ID appears (it starts with `-`)
4. Use that single ID; an SOS then reaches the whole club at once

### 5.4 Test it
```bash
npm run telegram -- <chatId>     # sends a real test alert to that chat
```

> **Corporate networks often block the Telegram Bot API** — it is a common malware
> command-and-control channel, so security tooling blocks it by default. If
> `npm run telegram` times out at the office but a bogus token returns 401 instantly,
> that is a network block rather than a bad token. Retry on mobile data, or from your
> production server.

---

## 6. How Authentication Works

Firebase has no "6-digit code to email" flow, so email sign-in uses a **magic link**:

1. Rider enters their email → `sendSignInLinkToEmail` sends a link to
   `<origin>/auth/callback`, and the address is stashed in `localStorage`.
2. Opening the link on the same device signs them in automatically (`App.tsx` redeems it
   on boot, before the auth listener attaches).
3. Opening it on a *different* device has no stashed address, so `AuthPage` asks for the
   email again and completes the sign-in from there.

Every API request sends a Firebase **ID token** as `Authorization: Bearer <token>`. The
backend verifies it with `admin.auth().verifyIdToken()` in
[backend/src/middleware/auth.ts](backend/src/middleware/auth.ts), and the Socket.IO
handshake does the same. ID tokens expire hourly; the client SDK refreshes them, and the
socket re-reads a fresh token on every reconnect attempt.

A rider's `profiles/{uid}` document is created on their first `GET /api/users/me` from the
token's own claims — no separate registration step.

---

## 7. Deployment

### Frontend → Vercel
```bash
cd frontend
npm run build
# Deploy dist/ to Vercel, set env vars in Vercel dashboard
```

Add the Vercel domain under **Firebase → Authentication → Settings → Authorized domains**,
otherwise Google popup and email-link sign-in are rejected in production.

### Backend → AWS EC2 (Ubuntu 24.04)
```bash
# On EC2:
npm install -g pm2
cd backend && npm install && npm run build
pm2 start dist/index.js --name riderhub-api
pm2 save
```

Put the service-account values in the EC2 environment rather than committing `.env`.

### Cloudflare
- Point domain to Vercel (frontend)
- Point api.yourdomain.com to EC2 IP
- Enable Proxy (orange cloud) for DDoS protection + SSL

---

## Project Structure

```
Biker App/
├── backend/            Node.js + Express + Socket.IO + TypeScript
│   └── src/
│       ├── config/     Firebase Admin (Firestore, Auth)
│       ├── lib/        Firestore helpers (ownership, joins, transactions)
│       ├── middleware/ Auth (Firebase ID token) + Security (Helmet, Rate limit)
│       ├── routes/     REST API (9 modules)
│       ├── socket/     Real-time tracking
│       └── services/   Telegram notifications
├── frontend/           React + TypeScript + Vite + Tailwind PWA
│   └── src/
│       ├── components/ UI + Layout components
│       ├── pages/      11 pages
│       ├── store/      Zustand (auth, garage, ride)
│       └── lib/        Firebase, API, Socket, Utils
├── scripts/            setup, doctor and dev helpers
├── firestore.rules     Client-side access rules
├── firestore.indexes.json
├── firebase.json       Rules/index paths + emulator ports
├── FIRESTORE_MODEL.md  Collection layout and design decisions
└── architecture.md     System design
```

---

## MVP Features (Phase 1 — Complete)

- [x] Google + Email magic-link authentication
- [x] Rider profile with emergency info
- [x] Motorcycle garage (multi-bike)
- [x] Group rides with 6-char invite codes
- [x] Live MapLibre map with real-time rider dots
- [x] Group chat
- [x] Destination pin (shared with all riders)
- [x] Fuel log with mileage analytics
- [x] Service history with parts tracking
- [x] Document expiry tracker (Insurance, PUC, RC, licence) with 30-day alerts
- [x] Maintenance reminders (distance + date)
- [x] SOS with GPS + Telegram alert
- [x] Motorcycle health score
- [x] Dashboard with stats
- [x] PWA (installable on mobile)
