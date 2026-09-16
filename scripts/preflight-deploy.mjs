// Before deploying, prove the credentials can actually reach the project.
//
// The Firebase CLI's own failure here is one sentence — "Failed to get Firebase project
// X. Please make sure the project exists and your account has permission to access it."
// — and it covers at least four unrelated causes: the key belongs to a different
// project, the service account has no role on this one, the Firebase Management API is
// off, or the key was revoked. Sorting that out from the Actions log is guesswork.
//
// So this runs first and says exactly which one it is, in terms of what to click.
// It authenticates the same way the CLI does (the key in GOOGLE_APPLICATION_CREDENTIALS)
// and asks the same API the CLI asks.
import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';

const PROJECT = process.argv[2];
if (!PROJECT) { console.error('usage: node scripts/preflight-deploy.mjs <project-id>'); process.exit(2); }

const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const IAM = `https://console.cloud.google.com/iam-admin/iam?project=${PROJECT}`;
// Everything goes to stdout, including failures: GitHub interleaves the two streams by
// arrival, so a diagnosis split across both arrives shuffled — the verdict printing
// above the facts it was drawn from. The non-zero exit is what marks the step failed.
const fail = (title, ...lines) => {
  console.log(`\n✖ ${title}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log('');
  process.exit(1);
};

if (!KEY_PATH || !existsSync(KEY_PATH)) {
  fail('No service-account key was provided.',
    'GOOGLE_APPLICATION_CREDENTIALS is not set, or points at nothing.',
    'Check the "Authenticate to Firebase" step ran and the FIREBASE_SERVICE_ACCOUNT secret exists.');
}

let key;
try { key = JSON.parse(readFileSync(KEY_PATH, 'utf8')); }
catch { fail('The service-account key is not valid JSON.', 'Re-paste the whole downloaded key file into the FIREBASE_SERVICE_ACCOUNT secret.'); }
if (!key.client_email || !key.private_key) {
  fail('That JSON is not a service-account key.',
    'It must contain "client_email" and "private_key".',
    'You may have pasted the *web app config* (apiKey, authDomain…) — that is a different thing.',
    'Get the right file from Google Cloud → IAM & Admin → Service Accounts → your account → Keys → Add key → JSON.');
}

console.log(`Deploy identity : ${key.client_email}`);
console.log(`Key belongs to  : ${key.project_id}`);
console.log(`Deploying to    : ${PROJECT}`);

// A key from another project is legal but almost always an accident: the Cloud console
// opens on whichever project you used last, and the service account gets created there.
if (key.project_id && key.project_id !== PROJECT) {
  fail(`The key belongs to project "${key.project_id}", not "${PROJECT}".`,
    'The service account was created in the wrong project.',
    `Create it in "${PROJECT}" instead: ${IAM.replace('/iam?', '/serviceaccounts?')}`,
    'Then download a new JSON key and replace the FIREBASE_SERVICE_ACCOUNT secret.');
}

/* ---------- authenticate exactly as the CLI does ---------- */
const b64u = (s) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({
  iss: key.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now, exp: now + 3600,
}))}`;
const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url')}`;

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
});
const tokenBody = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok) {
  fail('The service-account key was rejected by Google.',
    `${tokenBody.error ?? tokenRes.status}: ${tokenBody.error_description ?? ''}`,
    'The key has probably been deleted or disabled. Create a new JSON key and update the secret.');
}
const token = tokenBody.access_token;
const get = (url) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });

/* ---------- the call the CLI makes, with a readable verdict ---------- */
const projRes = await get(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`);
const proj = await projRes.json().catch(() => ({}));
const reason = proj?.error?.details?.find(d => d.reason)?.reason ?? '';
const detail = proj?.error?.message ?? '';

if (projRes.status === 403 && (reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(detail))) {
  const api = detail.match(/([a-z]+\.googleapis\.com)/)?.[1] ?? 'firebase.googleapis.com';
  fail(`The ${api} API is switched off for this project.`,
    `Enable it: https://console.cloud.google.com/apis/library/${api}?project=${PROJECT}`,
    'Then re-run the workflow. (It can take a minute to take effect.)');
}
if (projRes.status === 403) {
  fail(`${key.client_email} has no access to project "${PROJECT}".`,
    'The service account exists, but it was never granted a role on this project —',
    'creating the account and granting it access are two separate steps in the console.',
    '',
    `Open ${IAM}`,
    '→ Grant access → paste the address above as the principal, and add these roles:',
    '     Firebase Admin',
    '     Service Account User',
    '     Secret Manager Admin',
    '     Service Usage Admin',
    '→ Save, wait about a minute, then re-run the workflow.');
}
if (projRes.status === 404) {
  fail(`No Firebase project called "${PROJECT}" is visible to this account.`,
    'Either the project id is misspelt in .firebaserc and the workflow,',
    'or the Google Cloud project exists but Firebase was never added to it',
    '(Firebase Console → Add project → select the existing Google Cloud project).');
}
if (!projRes.ok) {
  fail(`Could not read the project (HTTP ${projRes.status}).`, detail || JSON.stringify(proj).slice(0, 300));
}

console.log(`\n✔ ${key.client_email} can see "${proj.displayName ?? PROJECT}".`);

/* ---------- warn about the things that would fail a few minutes later ---------- */
// Best effort: these checks need extra permissions the deploy does not strictly require,
// so a refusal here is not a failure — it just means we cannot look ahead.
const billing = await get(`https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`)
  .then(r => r.ok ? r.json() : null).catch(() => null);
if (billing && billing.billingEnabled === false) {
  fail('This project is still on the free Spark plan.',
    'Cloud Functions need the Blaze (pay-as-you-go) plan — the free allowances stay,',
    'but a billing account must be attached.',
    `Firebase Console → gear → Usage and billing → Modify plan → Blaze:`,
    `https://console.firebase.google.com/project/${PROJECT}/usage/details`,
    '',
    'Worth doing at the same time: Google Cloud → Billing → Budgets & alerts → set a small budget.');
}
if (billing?.billingEnabled) console.log('✔ Blaze plan is active (Cloud Functions can be deployed).');

// The first functions deploy turns these on itself, given Service Usage Admin. Listing
// them here means a missing role shows up now rather than ten minutes into a build.
const NEEDED = {
  'cloudfunctions.googleapis.com': 'Cloud Functions',
  'cloudbuild.googleapis.com': 'Cloud Build (packages the function)',
  'artifactregistry.googleapis.com': 'Artifact Registry (stores the image)',
  'run.googleapis.com': 'Cloud Run (2nd-gen functions run on it)',
  'eventarc.googleapis.com': 'Eventarc',
  'secretmanager.googleapis.com': 'Secret Manager (the API keys)',
  'firebasehosting.googleapis.com': 'Firebase Hosting',
};
const states = await Promise.all(Object.keys(NEEDED).map(async (s) => {
  const r = await get(`https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${s}`);
  return [s, r.ok ? (await r.json()).state : null];
}));
const off = states.filter(([, state]) => state === 'DISABLED').map(([s]) => s);
if (off.length) {
  console.log(`\n  Not yet enabled: ${off.map(s => `${s} (${NEEDED[s]})`).join(', ')}`);
  console.log('  The deploy will switch these on itself — that is what the Service Usage Admin role is for.');
  console.log('  If it fails saying it cannot, enable them by hand from the API library page.');
} else if (states.every(([, s]) => s === null)) {
  console.log('  (Could not read API states — not required, continuing.)');
} else {
  console.log('✔ Every API the deploy needs is enabled.');
}
console.log('');
