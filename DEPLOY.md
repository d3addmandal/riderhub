# Deploying RiderHub — completely free

Two halves, two free tiers:

| Part | Where | Plan | Cost |
|---|---|---|---|
| Frontend (the PWA) | Firebase Hosting | Spark | ₹0 |
| Database + sign-in | Firestore + Firebase Auth | Spark | ₹0 |
| Backend (Express API) | Oracle Cloud Always Free (Ampere A1) | Always Free | ₹0 |

Why the backend is not on Firebase: running a server there (Cloud Functions or
Cloud Run) needs the Blaze plan, which needs a card on file. Firebase Hosting is
static files only. The Oracle box is genuinely free and always on, which suits this
backend better anyway — it keeps route caches in memory and has no cold starts.

Firebase's free limits at club scale: Hosting 10 GB stored / 360 MB per day served;
Firestore 1 GiB stored, 50k reads and 20k writes per day. A hundred riders will not
approach any of these. The only real spend in this app is the Google Maps APIs, and
those are on their own free tiers as covered elsewhere.

---

## One-time setup

### 1. Firebase CLI, signed in

```
npm install -g firebase-tools
firebase login
```

`.firebaserc` already points at project `fly-with-pegasus`.

### 2. Firestore rules

The rules deny all direct client access — every read and write goes through the API,
which uses the Admin SDK and enforces ownership in code. Deploy them once, and again
whenever `firestore.rules` changes:

```
npm run deploy:rules
```

### 3. The backend on Oracle

On the Always Free instance (Ubuntu, Ampere A1):

```
sudo apt update && sudo apt install -y nodejs npm caddy
git clone <your repo> riderhub && cd riderhub/backend
npm ci && npm run build
```

Copy `backend/.env` onto the box **by `scp`, never by committing it** — it holds the
Firebase private key. Then set these in it:

```
# Both — Hosting serves the site on two domains and a rider may land on either.
FRONTEND_URL=https://fly-with-pegasus.web.app,https://fly-with-pegasus.firebaseapp.com
GOOGLE_MAPS_BROWSER_KEY=<a second key, restricted — see step 5>
```

Run it under systemd so it survives reboots and crashes:

```ini
# /etc/systemd/system/riderhub.service
[Unit]
Description=RiderHub API
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/riderhub/backend
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
EnvironmentFile=/home/ubuntu/riderhub/backend/.env

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl enable --now riderhub
```

### 4. HTTPS in front of it — not optional

Firebase Hosting is HTTPS. A browser will refuse to call a plain-HTTP API from an
HTTPS page (mixed content), and the app will simply look broken with no useful error.
So the API needs a hostname with a certificate. Point a DNS `A` record at the instance
(a free DuckDNS name works if you have no domain), then:

```
# /etc/caddy/Caddyfile
api.your-domain.example {
    reverse_proxy localhost:3001
}
```

```
sudo systemctl reload caddy
```

Caddy fetches and renews the Let's Encrypt certificate itself.

**Oracle has two firewalls.** Open ports 80 and 443 in the console's VCN security
list *and* in the instance's own iptables — the Oracle images ship with restrictive
rules preloaded, and forgetting the second one is a classic lost afternoon:

```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 5. Google Maps keys, restricted

In Google Cloud → Credentials:

- **Server key** (`GOOGLE_MAPS_API_KEY`): restrict to the Routes, Places and
  Geocoding APIs. Never leaves the Oracle box.
- **Browser key** (`GOOGLE_MAPS_BROWSER_KEY`): a *separate* key. Restrict it by
  HTTP referrer to `https://fly-with-pegasus.web.app/*` and
  `https://fly-with-pegasus.firebaseapp.com/*`, and to the Maps JavaScript API only.
  It is handed to signed-in riders at runtime, so the referrer lock is what protects it.

### 6. Point the frontend at the API

Edit `frontend/.env.production`:

```
VITE_API_URL=https://api.your-domain.example
```

---

## Deploying from the browser (no CLI)

Everything below is done in a web page; the Firebase CLI is never installed. The
mechanism is a GitHub Actions workflow, `.github/workflows/deploy-hosting.yml`, which
builds the site, runs the release guards and uploads it — GitHub's servers run the CLI
so you do not have to. It reads `firebase.json`, so rewrites and headers ship exactly
as tested.

### A. Put the code on GitHub (once)

1. Install **GitHub Desktop**, sign in, *File → Add local repository* → this folder →
   *Publish repository* → tick **Keep this code private**.
   `.gitignore` already keeps `backend/.env` and `frontend/.env` out; check the file
   list in GitHub Desktop before publishing — neither should appear.

### B. Give GitHub permission to deploy (once)

2. **Google Cloud Console** → project `fly-with-pegasus` → *IAM & Admin → Service
   Accounts → Create service account*. Name it `github-hosting-deploy`. Under *Grant
   this service account access*, add the role **Firebase Hosting Admin** (also add
   **API Keys Viewer** — harmless, and it lets the action fetch the web config if that
   is ever needed). *Done*.
3. Open the new account → *Keys → Add key → Create new key → JSON*. A file downloads.
4. **GitHub** → your repository → *Settings → Secrets and variables → Actions → New
   repository secret*. Name: `FIREBASE_SERVICE_ACCOUNT`. Value: the *entire* contents
   of the downloaded JSON file, pasted as-is. Save, then **delete the downloaded file**
   — it is a credential.

### C. Tell the build where things are (once)

5. Same page, *Variables* tab → *New repository variable*, one per line below. These
   are public values (the Firebase web config is an identifier, not a secret — access
   is controlled by the rules and Auth). Copy them from Firebase Console → *Project
   settings → General → Your apps → Web app → SDK setup and configuration*:

   | Variable | Value |
   |---|---|
   | `VITE_API_URL` | `https://api.your-domain.example` — the Oracle backend, HTTPS |
   | `VITE_FIREBASE_API_KEY` | `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | `fly-with-pegasus` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
   | `VITE_FIREBASE_APP_ID` | `appId` |
   | `VITE_TELEGRAM_BOT_USERNAME` | the club bot, without `@` (optional) |

   The workflow refuses to build if any Firebase value is missing or if `VITE_API_URL`
   is still the placeholder or not `https://`.

### D. Firestore rules and Hosting site (once)

6. **Firebase Console** → *Build → Firestore Database → Rules*. Replace the editor's
   contents with the contents of `firestore.rules` (deny-all) and click **Publish**.
   No indexes are needed — `firestore.indexes.json` is deliberately empty.
7. *Build → Hosting → Get started* → click through *Next / Next / Continue to console*
   (nothing to install; this just registers the default site `fly-with-pegasus.web.app`).
8. *Build → Authentication → Settings → Authorized domains*: `fly-with-pegasus.web.app`
   and `fly-with-pegasus.firebaseapp.com` should already be listed; add them if not, or
   Google sign-in will refuse the hosted site.

### E. Deploy

9. GitHub → *Actions → Deploy to Firebase Hosting → Run workflow → Run workflow*.
   Every push to `main` (a *Commit* + *Push origin* in GitHub Desktop) also deploys.
   A green tick means the site is live at `https://fly-with-pegasus.web.app` and the
   live-site verification passed; a red cross shows exactly which guard stopped it.

Backend changes still go to the Oracle box as in step 3 above; the workflow deploys
the website only.

## Branding: icon and splash

`icon.png` (the pegasus, transparent) and `logo.png` (the round badge) in the project
root are the only sources. Every launcher icon, the iOS touch icon, the favicon and the
splash badge are generated from them:

```
npm run brand:icons      # then rebuild / deploy as usual
```

What a rider sees: the pegasus as the home-screen icon (Android crops the maskable
variant to the launcher's shape; iOS uses the dark-ground touch icon), and the club
badge on a dark screen from the moment the app is tapped until the dashboard appears —
Android's own splash, then the boot screen baked into `index.html`, then the sign-in
gate, all on the same `#0f1117` ground so there is no flash between them. iOS has no
manifest splash; there the boot screen is the splash.

## Every deploy

```
npm run deploy:web
```

That builds the frontend, then refuses to deploy if either check fails:

- `tests/phase31.mjs` — no server secret has leaked into the bundle
- `tests/phase36.mjs` — the PWA is still installable (icons, manifest, worker)

and only then runs `firebase deploy --only hosting`.

To try a build on a throwaway URL first:

```
npm run deploy:preview      # live for 7 days on a preview channel
```

To check the hosting config locally without deploying anything:

```
npm run serve:web           # hosting on http://[::1]:27350 (uses firebase.emutest.json)
npm run test:hosting        # rewrites, headers, icons, no leaks, deny-all rules (see the Windows note below)
```

(Why IPv6 and high ports: on some Windows machines the OS reserves IPv4 loopback
ports — binding fails with EACCES even though nothing is listening — and the Firebase
CLI probes 127.0.0.1 specifically. `::1` is unaffected. Production is untouched; Hosting
has no port to configure.)

**Right after the first deploy, verify the live site:**

```
npm run test:hosting:prod
```

The live site is the final word on rewrites and headers. On Windows the local hosting
emulator cannot evaluate them at all: superstatic normalises paths with `path.join`,
which yields backslashes there, so no `source` glob or `regex` ever matches and every
deep link 404s locally. `npm run test:hosting` knows this and, on Windows, runs the
rules through superstatic's own matcher with POSIX paths instead; on Linux/macOS it
checks the emulator's real responses. Production Hosting is unaffected.

One rule that is easy to get wrong: the rewrite `regex` is compiled with **RE2**, which
has no lookahead/lookbehind. A JavaScript-only pattern would be accepted by the
editor and then fail at request time. The suite checks for that too.

Backend updates: `git pull && npm ci && npm run build && sudo systemctl restart riderhub`
on the Oracle box.

---

## After a deploy, if something looks stale

The PWA precaches the app shell. `sw.js` is served with `no-cache`, so a new worker is
picked up on the next load, but a rider who already has the app open may run the old
bundle until they reopen it. If a fix seems not to have arrived, that is why — close
and reopen, or clear site data.
