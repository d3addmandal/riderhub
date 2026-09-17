# Deploying RiderHub to Oracle Cloud

The whole application on one Always Free instance, driven by a single command.

```
sudo ./run.sh
```

First time it provisions the machine. Every time after, it pulls whatever has been
pushed to GitHub, rebuilds, and restarts — so the loop is: **you push, then run that on
the box.**

| Part | Where | Port |
|---|---|---|
| TLS, the PWA, and the `/api` proxy | Caddy | 443 public (80 redirects and renews the certificate) |
| Express API | Node under systemd | **8731, bound to 127.0.0.1** — unreachable from outside |
| Sign-in and database | Firebase Auth + Firestore | — |

One hostname, one origin. The browser never sees the API's port: Caddy serves the app
and forwards `/api/**` to it internally, so there is no CORS, no mixed content, and no
second certificate. That is why `VITE_API_URL` is empty.

**HTTPS is not optional.** Geolocation, the service worker, Web Share, Wake Lock and
DeviceOrientation are all refused outside a secure context. On plain HTTP the app would
install and then be unable to track a ride.

---

## First time

### 1. The instance

Oracle Cloud → *Compute → Instances → Create*. An **Ampere A1** shape from the Always
Free allowance is ideal — 1 OCPU / 6 GB or more. Image: **Ubuntu 22.04 or 24.04**. Add
your SSH public key when prompted.

(The smaller AMD micro shape works too — `run.sh` adds swap there, because a Vite build
on 1 GB gets killed by the OOM reaper with no useful message.)

### 2. Open the ports — there are two firewalls

- **VCN security list**, in the web console: *Networking → Virtual Cloud Networks →
  your VCN → Security Lists → Default* → *Add Ingress Rules* for TCP **80** and **443**
  from `0.0.0.0/0`.
- **The instance's own iptables** — `run.sh` handles this half.

Missing the console half is the single most common reason the site appears dead.

### 3. Point DNS at it

```
rides.example.com.   A   <instance public IP>
```

No domain? A free [DuckDNS](https://www.duckdns.org) name works — but **set it from the
server, not from your laptop.** DuckDNS records the address of whoever asks, so clicking
"update ip" in a browser at the office points the name at the office connection, and
whatever answers there serves your domain instead. The symptom is a certificate error
naming a machine you have never heard of.

From the instance:

```bash
sudo /srv/riderhub/app/run.sh --duckdns=<your-duckdns-token>
```

That points the name here now and installs a timer that keeps it pointed here — which
matters because an Oracle public address is *ephemeral* by default and changes when the
instance is stopped and started. (Alternatively, reserve the IP in the Oracle console and
the name never needs updating again.)

To check at any time which machine the name resolves to, and whether that is this one:

```bash
sudo /srv/riderhub/app/run.sh --whoami
```

Caddy cannot obtain a certificate until the name resolves to the instance.

### 4. Get the code onto the box and run it

SSH in, then either clone (best — later runs can pull):

```bash
sudo git clone https://github.com/d3addmandal/riderhub.git /srv/riderhub/app
cd /srv/riderhub/app
sudo ./run.sh
```

…or copy the folder up from Windows and run it from wherever it landed:

```bash
# from your PC
scp -r "Biker App" ubuntu@<ip>:~/riderhub
# on the box
cd ~/riderhub && sudo ./run.sh
```

It relocates itself to `/srv/riderhub/app` (the systemd unit is locked down with
`ProtectHome`, so the code cannot live under `/home`) and carries on from there.

It will ask for the hostname and an email for certificate warnings, then install Node 22
and Caddy, create the `riderhub` service user, open the firewall, build both halves, run
the release checks, and start everything under systemd.

If you copied up a working `backend/.env`, it seeds `/etc/riderhub/api.env` from it, so
there are no keys to retype.

### 5. Fill in the keys, if they were not seeded

```bash
sudo nano /etc/riderhub/api.env
sudo systemctl restart riderhub-api
```

| Key | Where it comes from |
|---|---|
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Firebase Console → Project settings → Service accounts → *Generate new private key*. Keep the quotes and the literal `\n`. |
| `GOOGLE_MAPS_API_KEY` | server key — Routes, Places, Geocoding |
| `GOOGLE_MAPS_BROWSER_KEY` | browser key — Maps JavaScript API |
| `GOOGLE_MAPS_MAP_ID` | optional; enables tilt and heading |
| `TELEGRAM_BOT_TOKEN` | optional; SOS alerts |

`PORT`, `BIND_HOST`, `TRUST_PROXY` and `FRONTEND_URL` are already correct.

### 6. Tell Google about the new address

Both are easy to forget and both fail confusingly:

- **Firebase Console → Authentication → Settings → Authorized domains** → add
  `rides.example.com`. Google sign-in and the email link refuse any origin not listed.
- **Google Cloud → Credentials → browser Maps key → Website restrictions** → add
  `https://rides.example.com/*`. Otherwise the map silently fails to load.

### 7. Only if the repo is private: let the machine pull

A public repo needs nothing here — `run.sh` clones and pulls over HTTPS.

If you make it private again, `git pull` needs read access. Generate a key on the box and
register it as a **deploy key** (read-only is enough):

```bash
sudo -u riderhub ssh-keygen -t ed25519 -N '' -f /srv/riderhub/.ssh/id_ed25519
sudo cat /srv/riderhub/.ssh/id_ed25519.pub
```

GitHub → repository → *Settings → Deploy keys → Add deploy key* → paste it. Then switch
the remote to SSH:

```bash
sudo git -C /srv/riderhub/app remote set-url origin git@github.com:d3addmandal/riderhub.git
```

`run.sh` prints these same instructions if a pull is ever refused.

---

## Changing the hostname

On the box:

```bash
sudo /srv/riderhub/app/run.sh --domain=rides.example.com
```

Nothing is rebuilt — the browser bundle calls `/api` on whatever origin it was opened
from, so no address is baked into it. The command rewrites Caddy's hostname and the API's
`FRONTEND_URL`, keeps the DuckDNS updater in step (or switches it off if the new name is
not a DuckDNS one), and reloads.

Three things outside the machine then have to agree, and until they do the site loads but
sign-in and the map fail with nothing useful in the console — the command prints this list
at the end too:

1. **DNS** — the new name must resolve to this instance. `--whoami` tells you whether it
   does. For a real domain, an `A` record; for DuckDNS, `--duckdns=<token>` from here.
2. **Firebase Console → Authentication → Settings → Authorized domains** — add the new
   name, remove the old one when nobody is on it.
3. **Google Cloud → Credentials → browser Maps key → Website restrictions** — add
   `https://<new name>/*`.

Caddy requests a certificate for the new name as soon as DNS points here; watch it with
`journalctl -u caddy -f`.

---

## Every deploy after that

I push to GitHub. You run:

```bash
sudo /srv/riderhub/app/run.sh
```

It pulls, installs, builds both halves, runs the three release guards (no server secret
in the browser bundle · the PWA is still installable · Caddy serves what the app
expects), validates the Caddyfile **before** reloading it, restarts the API, and then
refuses to report success until `/health` actually answers.

```bash
sudo /srv/riderhub/app/run.sh --no-pull   # rebuild what is already checked out
sudo /srv/riderhub/app/run.sh --status    # what is running, plus recent logs
```

Nothing has to be done after a reboot — both services come back on their own.

---

## Checking on it

```bash
systemctl status riderhub-api caddy
journalctl -u riderhub-api -f          # API logs, live
journalctl -u caddy -n 50              # certificate problems show up here
curl -s localhost:8731/health          # the API, bypassing Caddy
```

From any machine, against the real site:

```bash
node tests/phase37.mjs https://rides.example.com
```

That checks the certificate, the deep-link rewrites, the caching headers, the icons, and
that `/api` is not being swallowed by the app shell.

---

## Moving across from Firebase Hosting

Nothing was removed — `fly-with-pegasus.web.app` still works, so run both and switch
when you are satisfied.

1. Deploy to Oracle and open `https://rides.example.com`. Sign in, start a ride, watch
   the map draw and the marker move.
2. Install it to a phone home screen from the new address.
3. Once a real ride has worked, retire the Firebase copies so nobody lands on a stale app:
   ```
   firebase hosting:disable --project fly-with-pegasus
   firebase functions:delete api --region asia-south1 --project fly-with-pegasus
   ```
   The old URL then stops serving, so do this only afterwards. Firestore and Auth are
   untouched — the Oracle box uses both.
4. With the Cloud Function gone, nothing needs Blaze any more. You can drop back to
   Spark, or leave Blaze with the budget alert in place.

---

## When something is wrong

**Nothing loads at all.** From your laptop, `curl -v https://rides.example.com`:

- It *hangs* → a firewall. Almost always the VCN security list; the iptables half is
  scripted, the console half is not.
- It says *connection refused* → Caddy is not running. `journalctl -u caddy -n 20`.
  The usual cause is another web server already holding port 80 or 443, which makes
  Caddy exit at startup. `run.sh` names the offender before it gets that far; to look
  yourself:

  ```bash
  sudo ss -lptn 'sport = :80 or sport = :443'
  sudo systemctl disable --now apache2     # or nginx, or whatever it names
  ```

**"Your connection is not private", or a stranger's web page appears.** The domain
resolves to a different machine, so Let's Encrypt validated against that one and Caddy
never got a certificate. Check with `sudo /srv/riderhub/app/run.sh --whoami`; if the two
addresses differ, fix the DNS record (for DuckDNS, `--duckdns=<token>` from the server).
Otherwise `journalctl -u caddy -n 50` says what else went wrong — usually port 80
blocked, which Let's Encrypt needs for validation.

**The app loads but sign-in fails.** The domain is missing from Firebase → Authentication
→ Authorized domains (step 6).

**The map never appears.** The browser key's referrer restrictions do not include the new
domain (step 6), or `GOOGLE_MAPS_BROWSER_KEY` is blank in `/etc/riderhub/api.env`.

**`run.sh` fails at "Pulling from GitHub".** It prints git's own message and then what
to do about that particular one — authentication (step 7, private repos only), or a
checkout that has drifted from GitHub and cannot fast-forward. `--no-pull` builds and
deploys what is already there meanwhile.

"detected dubious ownership" is handled automatically now: git distrusts a repository
owned by another user, and the tree belongs to the `riderhub` service account while the
script runs as root. If you hit it on an older copy of the script:
`sudo git config --global --add safe.directory /srv/riderhub/app`.

**The API will not start** — "Missing Firebase Admin credentials", restarting for ever.

`/etc/riderhub/api.env` is the only file the service reads. Putting the values in
`backend/.env` on the box does **not** work, and the reason is worth knowing: systemd
copies every line of `api.env` into the environment, blanks included, and dotenv refuses
to overwrite a variable that already exists — so an empty value there beats anything
`backend/.env` has. `run.sh` checks this before building now, and copies values across
from a `backend/.env` it finds rather than letting the service crash-loop.

By hand:

```bash
sudo nano /etc/riderhub/api.env
sudo systemctl restart riderhub-api
```

`FIREBASE_PRIVATE_KEY` stays on one line, keeping its surrounding quotes and its literal
`\n` escapes exactly as they appear in the downloaded JSON.

**API calls return HTML.** The `handle /api/*` block is missing or ordered after the
catch-all, so the app shell is answering. `node tests/phase40.mjs` catches that before a
deploy ever happens.
