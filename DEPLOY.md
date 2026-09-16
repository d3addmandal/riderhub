# Deploying RiderHub — everything on Firebase

| Part | Firebase product | What it costs at club scale |
|---|---|---|
| The site (PWA) | Hosting | ₹0 — 10 GB stored, 360 MB/day served free |
| The API (Express) | Cloud Functions, 2nd gen, `asia-south1` | ₹0 — 2 M calls, 400 k GB-s/month free |
| Database + sign-in | Firestore + Authentication | ₹0 — 1 GiB, 50 k reads / 20 k writes a day free |
| Keys and tokens | Secret Manager | ₹0 — 6 secret versions free |

One site, one origin. Hosting serves the app and rewrites `/api/**` to the function, so
there is no second hostname, no CORS, no certificate, no server to keep alive.

**The one thing to know before starting: Cloud Functions require the Blaze plan.** Blaze
is pay-as-you-go with the same free allowances as Spark on top — a club of riders will
not get near them — but it needs a billing account (a card) on the project. Set a
budget alert (Google Cloud → Billing → Budgets & alerts, e.g. ₹100) on day one so an
accident can never be a surprise. The Maps APIs were already on Google Cloud billing
and are unchanged by this.

Nothing below needs the Firebase CLI on your computer. Deploys run from GitHub
(`.github/workflows/deploy-hosting.yml`): its runner installs the CLI, builds both halves,
runs the release guards, uploads, and checks the live site.

---

## One-time setup (about 30 minutes, all in a browser)

### 1. Upgrade the project to Blaze

Firebase Console → project `fly-with-pegasus` → gear → *Usage and billing* → *Modify
plan* → **Blaze**. Attach or create a billing account. Then Google Cloud Console →
*Billing → Budgets & alerts → Create budget* for a small amount with email alerts.

### 2. The code on GitHub

Already done: https://github.com/d3addmandal/riderhub (private). Later changes: commit
and push from GitHub Desktop; every push to `main` deploys.

### 3. A service account that may deploy

1. Google Cloud Console → `fly-with-pegasus` → *IAM & Admin → Service Accounts →
   Create service account*. Name: `github-deploy`.
2. Grant these roles (add one at a time):
   - **Firebase Admin** — Hosting, Functions, Firestore rules
   - **Service Account User** — required to deploy a function that runs as the
     project's default service account
   - **Secret Manager Admin** — lets the deploy grant the function access to its secrets
   - **Service Usage Admin** — lets the first deploy switch on the Cloud Functions,
     Cloud Build, Artifact Registry, Cloud Run and Eventarc APIs it needs
3. Open the account → *Keys → Add key → Create new key → JSON*. A file downloads.
4. GitHub → repository → *Settings → Secrets and variables → Actions → New repository
   secret*. Name `FIREBASE_SERVICE_ACCOUNT`; value = the **entire** contents of the file.
   Save, then **delete the downloaded file** — it is a credential.

### 4. The API's secrets — required before the first deploy

The function declares these three by name, so the deploy looks each one up and stops if
it is missing. Create all three before running the workflow.

All three values are already in your local `backend/.env`, so the quickest way is to
copy them across with one command:

```
gcloud auth login          # only if it says your login has expired
npm run secrets:push       # reads backend/.env, creates what is missing
```

It is safe to re-run, and it is also how you rotate a key later: change the value in
`backend/.env`, run it again, deploy. Nothing is printed, and the values never pass
through the shell.

By hand instead: Google Cloud Console → *Security → Secret Manager* → *Create secret*,
three times (if the page offers to enable the API, accept). The **name must match
exactly**, the value is the raw key or token, every other option stays at its default.
Watch for a trailing space when pasting — the console keeps it:

| Secret name | Value |
|---|---|
| `GOOGLE_MAPS_API_KEY` | server key: Routes, Places, Geocoding APIs. Never reaches a browser. |
| `GOOGLE_MAPS_BROWSER_KEY` | a *separate* key restricted by HTTP referrer to `https://fly-with-pegasus.web.app/*` and `https://fly-with-pegasus.firebaseapp.com/*`, Maps JavaScript API only |
| `TELEGRAM_BOT_TOKEN` | the club bot's token from @BotFather |

The function binds them by name (`backend/src/function.ts`); the deploy grants it
read access automatically. Rotating a key = *Add new version* here + *Run workflow*.

Optional non-secret setting: a vector **Map ID** for tilt/heading navigation goes in
`backend/.env.fly-with-pegasus` (a committed file — public values only).

### 5. The site's build settings

GitHub → *Settings → Secrets and variables → Actions → Variables → New repository
variable*, one each. These are public identifiers, not secrets; copy them from Firebase
Console → *Project settings → General → Your apps → Web app → SDK setup and
configuration*:

| Variable | Firebase field |
|---|---|
| `VITE_FIREBASE_API_KEY` | `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` (`fly-with-pegasus`) |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `VITE_FIREBASE_APP_ID` | `appId` |
| `VITE_TELEGRAM_BOT_USERNAME` | the bot's @name without the @ (optional) |

Do **not** set `VITE_API_URL` — empty means "same origin", which is what Hosting gives
you. The workflow refuses to build if a Firebase value is missing.

### 6. Firebase Console, three clicks

- *Build → Hosting → Get started* → Next / Next / *Continue to console*. Registers
  `fly-with-pegasus.web.app`. Nothing to install.
- *Build → Authentication → Settings → Authorized domains* — confirm both
  `fly-with-pegasus.web.app` and `fly-with-pegasus.firebaseapp.com` are listed.
- Firestore rules need no manual step: the workflow deploys `firestore.rules`
  (deny-all — every read and write goes through the API).

---

## Every deploy

GitHub → *Actions → Deploy to Firebase → Run workflow*. Or just push to `main`.

The job, in order: install → resolve build settings → build site → build API →
guards (no secret in the bundle · PWA installable · API correctly wired as a function)
→ `firebase deploy --only hosting,functions,firestore:rules` → verify the live site.
A red cross names the step; the log says why.

The first functions deploy takes 5–10 minutes (it enables APIs and builds a container);
later ones 2–4. The site is live at **https://fly-with-pegasus.web.app**.

### Checking it locally instead

```
npm run build              # both halves
node tests/phase39.mjs     # the function loads the way the runtime loads it
npm run serve:web          # hosting emulator on http://[::1]:27350
npm run test:hosting       # rewrites, headers, icons, deny-all rules
```

On Windows the hosting emulator cannot evaluate rewrites or headers (its path matcher
produces backslashes there), so `test:hosting` runs the rules through the emulator's own
matcher with POSIX paths instead; on Linux/macOS it checks live responses. The real site
is the final word: `npm run test:hosting:prod` after a deploy (the workflow does this).

### If you ever deploy from a laptop with the CLI

`npm run deploy:web` does the same as the workflow. Two catches: the CLI reads
`backend/.env` as function configuration and **rejects** it (keys starting `FIREBASE_`
are reserved), so move that file aside for the deploy; and `firebase login` is needed
once. The GitHub path avoids both.

---

## When a deploy fails

The job checks the credentials before uploading anything and prints a specific
instruction. The one worth knowing in advance:

**"Failed to get Firebase project fly-with-pegasus"** — the project is fine; the
service account cannot see it. Creating a service account and *granting it access* are
two separate steps in the Google Cloud console, and the second one is easy to miss.

Open **IAM & Admin → IAM** for the project, and look for
`github-deploy@fly-with-pegasus.iam.gserviceaccount.com` in the list.

- **Not there** → *Grant access*, paste that address as the principal, add the four
  roles from step 3, save, wait a minute, re-run.
- **There, but with fewer roles** → edit it and add the missing ones.
- **The address is `…@some-other-project.iam.gserviceaccount.com`** → the account was
  created in the wrong project (the console opens on whichever project you used last).
  Create it under `fly-with-pegasus` and replace the `FIREBASE_SERVICE_ACCOUNT` secret
  with the new key.

The preflight prints which of these it is, along with the account it is actually using.

**"Secret Manager API has not been used in project… or it is disabled"** — shouldn't
happen any more: the preflight now switches on every API the deploy needs (that is what
the *Service Usage Admin* role is for) and waits for them to come up. The Firebase CLI
enables Cloud Functions, Cloud Build and Artifact Registry itself but not Secret
Manager, which it reads while resolving the function's secrets — several minutes in.

**"N of the 3 secrets the API needs do not exist yet"** — step 4 was skipped, or a name
is misspelt. The names must match `backend/src/function.ts` exactly. The message lists
the missing ones and links to the page.

Other failures it names directly: a key that was deleted, and the project still being on
Spark when Cloud Functions need Blaze.

The Actions log also shows a yellow warning that `actions/checkout@v4` and
`actions/setup-node@v4` target Node 20. That is a GitHub deprecation notice, not a
problem — the runner runs them on Node 24 and the deploy is unaffected.

## Branding: icon and splash

`icon.png` (the pegasus, transparent) and `logo.png` (the round badge) in the project
root are the only sources. Every launcher icon, the iOS touch icon, the favicon and the
splash badge are generated from them:

```
npm run brand:icons        # then commit, push (= deploy)
```

What a rider sees: the pegasus as the home-screen icon (Android crops the maskable
variant to the launcher's shape; iOS uses the dark-ground touch icon), and the club
badge on a dark screen from the moment the app is tapped until the dashboard appears —
Android's own splash, then the boot screen baked into `index.html`, then the sign-in
gate, all on the same `#0f1117` ground so there is no flash between them. iOS has no
manifest splash; there the boot screen is the splash.

---

## How it behaves in production

- **Cold starts.** The function scales to zero when idle (that is what keeps it free).
  The first API call after a quiet spell takes a few seconds; the boot screen covers
  it. Riders on a group ride keep it warm between them.
- **Rate limits** are per function instance, keyed on the rider's real address
  (Hosting's proxy is trusted only inside Cloud Run).
- **Stale app after a deploy.** `sw.js` is served `no-cache`, so a new version is picked
  up on the next open; someone with the app already open runs the old bundle until
  they reopen it.
- **No websockets.** Positions of other riders are polled through the API — a function
  cannot hold a connection, and for a club-sized group polling is the simpler design.
