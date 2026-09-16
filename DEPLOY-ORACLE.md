# Deploying RiderHub to Oracle Cloud

The whole application on one Always Free instance. Firebase keeps only Auth and
Firestore — both are free, neither needs a server, and neither needs the Blaze plan
once Cloud Functions are out of the picture.

| Part | Where | Port |
|---|---|---|
| TLS, the PWA, and the `/api` proxy | Caddy | 443 public (80 redirects and renews the certificate) |
| Express API | Node, systemd | **8731, bound to 127.0.0.1** — unreachable from outside |
| Sign-in and database | Firebase Auth + Firestore | — |

One hostname, one origin. The rider's browser never sees the API's port: Caddy serves
the app and forwards `/api/**` to it internally, so there is no CORS, no mixed content,
and no second certificate. `VITE_API_URL` stays empty for exactly this reason.

**HTTPS is not optional.** The app uses geolocation, the service worker, Web Share,
Wake Lock and DeviceOrientation, and browsers refuse all of them outside a secure
context. Plain HTTP would leave the app looking installed but unable to track a ride.

---

## One-time setup

### 1. The instance

Oracle Cloud → *Compute → Instances → Create*. An **Ampere A1** shape (ARM) from the
Always Free allowance is ideal — take 1 OCPU / 6 GB or more. Image: **Ubuntu 22.04 or
24.04**. Add your SSH public key when prompted.

### 2. Open the ports — both firewalls

Oracle has two, and missing the second is the classic lost afternoon.

- **VCN security list** (web console): *Networking → Virtual Cloud Networks → your VCN →
  Security Lists → Default* → *Add Ingress Rules* for TCP **80** and **443** from
  `0.0.0.0/0`. Do this in the console; nothing else can.
- **The instance's own iptables**: handled by the setup script below.

### 3. DNS

Point a hostname at the instance's public IP:

```
rides.example.com.   A   <instance public IP>
```

No domain? A free [DuckDNS](https://www.duckdns.org) name (`yourclub.duckdns.org`) works
fine. Caddy cannot get a certificate until this resolves.

### 4. Provision the machine

SSH in and run:

```bash
git clone https://github.com/d3addmandal/riderhub.git
cd riderhub
sudo bash deploy/setup-oracle.sh rides.example.com you@example.com
```

It installs Node 22 and Caddy, creates the `riderhub` service user and directories,
opens 80/443 in iptables, installs the Caddyfile and the systemd unit, and writes two
configuration files. It puts **no** secret anywhere — it creates
`/etc/riderhub/api.env` with blanks and leaves the filling-in to you, so nothing
sensitive ever lands in your shell history.

### 5. Fill in the API's configuration

```bash
sudo nano /etc/riderhub/api.env
```

The same values your `backend/.env` already holds:

| Key | Where it comes from |
|---|---|
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Firebase Console → Project settings → Service accounts → *Generate new private key*. Keep the quotes and the literal `\n` escapes. |
| `GOOGLE_MAPS_API_KEY` | server key — Routes, Places, Geocoding |
| `GOOGLE_MAPS_BROWSER_KEY` | browser key — Maps JavaScript API |
| `GOOGLE_MAPS_MAP_ID` | optional; enables tilt and heading |
| `TELEGRAM_BOT_TOKEN` | optional; SOS alerts |

`PORT`, `BIND_HOST`, `TRUST_PROXY` and `FRONTEND_URL` are already set correctly.

### 6. Tell Google about the new address

Both are easy to forget and both fail confusingly:

- **Firebase Console → Authentication → Settings → Authorized domains** → add
  `rides.example.com`. Google sign-in and the email link refuse any origin not listed.
- **Google Cloud → Credentials → your browser key → Website restrictions** → add
  `https://rides.example.com/*`. Otherwise the map silently fails to load.

### 7. Let GitHub deploy

Repository → *Settings → Secrets and variables → Actions*:

| | Name | Value |
|---|---|---|
| Secret | `ORACLE_SSH_KEY` | the **private** key matching the public key on the instance, whole file including the BEGIN/END lines |
| Secret | `ORACLE_HOST` | the instance's public IP or hostname |
| Variable | `ORACLE_USER` | `ubuntu` (Oracle's Ubuntu images) |
| Variable | `ORACLE_SSH_PORT` | only if sshd is not on 22 |
| Variable | `RIDERHUB_DOMAIN` | `rides.example.com` — used for the post-deploy check |

The five `VITE_FIREBASE_*` variables are already set from the Firebase deploy and are
reused as-is. `VITE_API_URL` must **not** be set; the workflow refuses to build if it is.

---

## Every deploy

GitHub → *Actions* → **Deploy to Oracle** → *Run workflow*.

Both halves are built on GitHub's runner — a Vite build on a small instance is slow at
best and killed by the OOM reaper at worst — then only compiled output and the manifests
are uploaded. The instance runs `npm ci --omit=dev` so anything native matches its own
architecture, restarts the API, validates the Caddyfile *before* reloading it, and
confirms `/health` answers before reporting success. Finally the workflow checks the
live site from outside.

Manually on the box, if you ever need to:

```bash
cd /srv/riderhub/current && bash deploy/apply.sh
```

---

## Checking on it

```bash
systemctl status riderhub-api caddy
journalctl -u riderhub-api -f          # API logs, live
journalctl -u caddy -n 50              # certificate problems show up here
curl -s localhost:8731/health          # the API, bypassing Caddy
```

From anywhere:

```bash
node tests/phase37.mjs https://rides.example.com
```

That asserts the certificate, the deep-link rewrites, the cache headers, the icons, and
that `/api` is not being swallowed by the app shell.

---

## Moving across from Firebase Hosting

Nothing was removed — `fly-with-pegasus.web.app` still works, so you can run both and
switch when you are satisfied.

1. Deploy to Oracle and open `https://rides.example.com`. Sign in, start a ride, check
   the map draws and the location marker moves.
2. Install it to a phone home screen from the new address.
3. Once you are happy, retire the Firebase copies so nobody lands on a stale app:
   ```
   firebase hosting:disable --project fly-with-pegasus
   firebase functions:delete api --region asia-south1 --project fly-with-pegasus
   ```
   Both are irreversible in the sense that the old URL stops serving — do them only
   after the new address has been used for a real ride. Firestore and Auth are untouched.
4. With the function gone, nothing on the project needs Blaze any more. You can drop
   back to Spark, or leave Blaze in place with the budget alert.

---

## When something is wrong

**The site does not load at all.** Almost always the VCN security list — the iptables
half is scripted, the console half is not. Check with
`curl -v https://rides.example.com` from your laptop; a hang means a firewall, a refused
connection means Caddy is not running.

**"Your connection is not private".** Caddy could not get a certificate. `journalctl -u
caddy -n 50` says why; nearly always DNS not yet pointing at the instance, or port 80
blocked (Let's Encrypt validates over port 80).

**The app loads but sign-in fails.** The domain is missing from Firebase
Authentication → Authorized domains (step 6).

**The map does not appear.** The browser key's referrer restriction does not include the
new domain (step 6), or `GOOGLE_MAPS_BROWSER_KEY` is blank in `/etc/riderhub/api.env`.

**Everything 404s except the home page.** Caddy is serving without the SPA fallback —
check `/etc/caddy/Caddyfile` matches `deploy/Caddyfile` and reload.

**API calls return HTML.** The `handle /api/*` block is missing or ordered after the
catch-all, so the shell is answering. `node tests/phase40.mjs` catches this before a
deploy.
