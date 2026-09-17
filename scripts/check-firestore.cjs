// Can the API's credentials actually reach Firestore?
//
//   node scripts/check-firestore.cjs            # uses backend/.env
//   set -a; . /etc/riderhub/api.env; set +a; node scripts/check-firestore.cjs
//
// Worth its own check because the failure is invisible from outside: the process starts,
// /health answers, riders sign in — and then nothing saves, because verifying an ID token
// needs no credentials while reading and writing does. A deploy can look completely
// successful while the app is useless.
//
// Read-only. Nothing is written.
const path = require('path');
const ROOT = path.dirname(__dirname);

// Only load backend/.env when the values are not already in the environment, so the
// server can source /etc/riderhub/api.env and have that win.
if (!process.env.FIREBASE_CLIENT_EMAIL) {
  try { require(path.join(ROOT, 'backend/node_modules/dotenv')).config({ path: path.join(ROOT, 'backend/.env') }); } catch {}
}
// Talking to the real project, never a local emulator.
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const fail = (title, ...lines) => {
  console.log(`\n✖ ${title}\n`);
  for (const l of lines) console.log(`  ${l}`);
  console.log('');
  process.exit(1);
};
const REGENERATE = [
  'Firebase Console → Project settings → Service accounts → Generate new private key.',
  'That downloads a JSON file, and recreates the Admin SDK account if it is missing.',
  '',
  'Put the two values from it into the configuration the API reads:',
  '',
  '  sudo nano /etc/riderhub/api.env      # FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
  '  sudo systemctl restart riderhub-api',
  '',
  'Keep the private key on one line, with its surrounding quotes and its literal \\n',
  'escapes exactly as they appear in the JSON. Then delete the downloaded file.',
];

if (!projectId || !clientEmail || !privateKey) {
  fail('No Firebase Admin credentials in the environment.',
    `FIREBASE_PROJECT_ID  ${projectId ? 'set' : 'MISSING'}`,
    `FIREBASE_CLIENT_EMAIL ${clientEmail ? 'set' : 'MISSING'}`,
    `FIREBASE_PRIVATE_KEY  ${privateKey ? 'set' : 'MISSING'}`);
}

(async () => {
  // Ask Google for a token first. Its error names the cause precisely, where the
  // Firestore client would only say UNAUTHENTICATED whatever the reason.
  const { createSign } = require('crypto');
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b({ alg: 'RS256', typ: 'JWT' })}.${b({
    iss: clientEmail, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  })}`;

  let assertion;
  try {
    assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
  } catch (e) {
    fail('The private key is not usable as a key.', e.message, '',
      'Usually it lost its line breaks in copying.', ...REGENERATE);
  }

  let res, body;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(20000),
    });
    body = await res.json();
  } catch (e) {
    // Could not reach Google at all — a network problem, not a credential one. Say so
    // rather than sending someone off to regenerate a key that is probably fine.
    console.log(`\n  Could not reach Google to check credentials (${e.message}). Skipping.`);
    process.exit(0);
  }

  if (!res.ok) {
    const desc = body.error_description || body.error || `HTTP ${res.status}`;
    if (/account not found|invalid_grant/i.test(desc)) {
      fail(`Google does not recognise ${clientEmail}.`,
        `"${desc}"`,
        '',
        'The service account has been deleted, or its key revoked. Sign-in will keep',
        'working — verifying a token needs no credentials — but nothing will save.',
        '', ...REGENERATE);
    }
    fail('Google refused these credentials.', `"${desc}"`, '', ...REGENERATE);
  }

  // The token is good; now prove the database itself is reachable and writable by us.
  const token = body.access_token;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/motorcycles?pageSize=1`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  if (r.status === 403) {
    fail('The credentials are valid but may not use Firestore.',
      `${clientEmail} is missing a role on ${projectId}.`,
      '',
      'Google Cloud → IAM & Admin → IAM → grant it "Cloud Datastore User"',
      '(the Firebase Admin SDK account normally has this already).');
  }
  if (r.status === 404) {
    fail(`Project ${projectId} has no Firestore database.`,
      'Firebase Console → Build → Firestore Database → Create database.',
      'Choose Native mode; Datastore mode will not work with this app.');
  }
  if (!r.ok) {
    const t = await r.text();
    fail(`Firestore returned HTTP ${r.status}.`, t.slice(0, 300));
  }

  console.log(`credentials OK — ${clientEmail.replace(/@.*/, '@…')} can read Firestore in ${projectId}`);
})();
