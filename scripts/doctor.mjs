#!/usr/bin/env node
/**
 * RiderHub setup doctor.
 *
 * Checks the toolchain, both .env files, and — crucially — whether the credentials
 * actually work against live Firebase. Tells you what to fix, not just that it broke.
 *
 *   npm run doctor
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

let failed = 0, warned = 0;
const pass = m => console.log(`  ${c.green}✓${c.reset} ${m}`);
const fail = (m, fix) => { failed++; console.log(`  ${c.red}✗${c.reset} ${m}`); if (fix) console.log(`    ${c.dim}→ ${fix}${c.reset}`); };
const warn = (m, fix) => { warned++; console.log(`  ${c.yellow}!${c.reset} ${m}`); if (fix) console.log(`    ${c.dim}→ ${fix}${c.reset}`); };
const section = m => console.log(`\n${c.bold}${c.cyan}${m}${c.reset}`);

/** Turn Google's verbose SDK errors into one actionable line. */
function diagnose(e) {
  const m = String(e?.message || e);
  if (/invalid_grant|account not found|UNAUTHENTICATED|invalid authentication credentials/i.test(m))
    return ['Credentials rejected by Google',
            'The service account key is wrong, revoked, or from a deleted project. Generate a new private key and re-run npm run setup. (Also check your system clock is correct.)'];
  if (/NOT_FOUND|does not exist/i.test(m))
    return ['Firestore database has not been created',
            'Firebase Console → Build → Firestore Database → Create database (production mode)'];
  if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(m))
    return ['Required Google API is not enabled for this project',
            'Enable it in the Firebase console, wait ~1 minute, then re-run'];
  if (/PERMISSION_DENIED/i.test(m))
    return ['Permission denied',
            'The service account may lack the Editor/Firebase Admin role on this project'];
  if (/ENOTFOUND|EAI_AGAIN|network|ETIMEDOUT/i.test(m))
    return ['Could not reach Google', 'Check your internet connection or proxy'];
  return [m.split('\n')[0].slice(0, 140), null];
}

const PLACEHOLDERS = [
  'your-firebase-project-id', 'your-project', 'REPLACE_ME', 'AIzaSy-REPLACE_ME',
  'firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com',
  'your-telegram-bot-token', '123456789012', 'your-firebase-project-id.firebasestorage.app',
  '1:123456789012:web:abcdef123456', '1:123456789012:web:abcdef',
];
const isPlaceholder = v => !v || PLACEHOLDERS.includes(v) || /REPLACE_ME|your-project|xxxxx/i.test(v);

/** Minimal .env parser: handles quoted values and preserves \n escapes. */
function parseEnv(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

console.log(`${c.bold}\n🏍️  RiderHub — Setup Doctor${c.reset}`);

// ── 1. Toolchain ───────────────────────────────────────────────
section('Toolchain');
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? pass(`Node ${process.versions.node}`)
            : fail(`Node ${process.versions.node} is too old`, 'Install Node 18 or newer');

for (const d of ['backend', 'frontend']) {
  existsSync(join(ROOT, d, 'node_modules'))
    ? pass(`${d}/node_modules installed`)
    : fail(`${d} dependencies missing`, `npm --prefix ${d} install`);
}

// ── 2. backend/.env ────────────────────────────────────────────
section('backend/.env');
const be = parseEnv(join(ROOT, 'backend', '.env'));
if (!be) {
  fail('backend/.env not found', 'npm run setup');
} else {
  for (const k of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']) {
    if (!be[k]) fail(`${k} missing`, 'npm run setup');
    else if (isPlaceholder(be[k])) fail(`${k} is still a placeholder`, 'npm run setup');
    else pass(`${k} set`);
  }
  if (be.FIREBASE_PRIVATE_KEY && !isPlaceholder(be.FIREBASE_PRIVATE_KEY)) {
    const key = be.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
    key.includes('-----BEGIN PRIVATE KEY-----') && key.includes('-----END PRIVATE KEY-----')
      ? pass('Private key looks like a valid PEM')
      : fail('Private key is malformed', 'Re-run npm run setup; keep the \\n escapes and the quotes');
  }
  if (!be.FRONTEND_URL) warn('FRONTEND_URL not set — CORS will fall back to *', 'Set it to your frontend origin');
  else pass(`FRONTEND_URL = ${be.FRONTEND_URL}`);
  if (!be.TELEGRAM_BOT_TOKEN || isPlaceholder(be.TELEGRAM_BOT_TOKEN)) {
    warn('TELEGRAM_BOT_TOKEN not set — SOS and reminder alerts are disabled', 'Optional. See SETUP.md §5');
  } else pass('TELEGRAM_BOT_TOKEN set');
}

// ── 3. frontend/.env ───────────────────────────────────────────
section('frontend/.env');
const fe = parseEnv(join(ROOT, 'frontend', '.env'));
if (!fe) {
  fail('frontend/.env not found', 'npm run setup');
} else {
  for (const k of ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
                   'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID']) {
    if (!fe[k]) fail(`${k} missing`, 'npm run setup');
    else if (isPlaceholder(fe[k])) fail(`${k} is still a placeholder`, 'npm run setup');
    else pass(`${k} set`);
  }
  if (fe.VITE_FIREBASE_API_KEY && !isPlaceholder(fe.VITE_FIREBASE_API_KEY) && !fe.VITE_FIREBASE_API_KEY.startsWith('AIza')) {
    warn('VITE_FIREBASE_API_KEY does not start with "AIza"', 'Double-check you copied the web apiKey');
  }
  if (!fe.VITE_API_URL) fail('VITE_API_URL missing', 'Set to http://localhost:3001 for local dev');
  else pass(`VITE_API_URL = ${fe.VITE_API_URL}`);
  if (fe.VITE_MAPBOX_TOKEN) warn('VITE_MAPBOX_TOKEN is leftover and unused', 'Maps use MapLibre + OpenFreeMap now; safe to delete the line');
}

// ── 4. Cross-file consistency ──────────────────────────────────
if (be && fe) {
  section('Consistency');
  be.FIREBASE_PROJECT_ID === fe.VITE_FIREBASE_PROJECT_ID
    ? pass(`Both point at project "${be.FIREBASE_PROJECT_ID}"`)
    : fail(`Project mismatch: backend "${be.FIREBASE_PROJECT_ID}" vs frontend "${fe.VITE_FIREBASE_PROJECT_ID}"`,
           'They must be the same Firebase project or tokens will not verify');
  if (be.FIREBASE_STORAGE_BUCKET || fe.VITE_FIREBASE_STORAGE_BUCKET) {
    warn('A storage bucket variable is set but unused',
         'Cloud Storage needs a paid Blaze plan, so this app does not use it. Safe to delete the line.');
  } else {
    pass('No Cloud Storage configured — stays on the free Spark plan');
  }
}

// ── 5. Live Firebase ───────────────────────────────────────────
section('Live Firebase connection');
const credsReady = be && ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
  .every(k => be[k] && !isPlaceholder(be[k]));

if (!credsReady) {
  warn('Skipped — fix backend/.env first');
} else {
  try {
    const require = createRequire(join(ROOT, 'backend', 'package.json'));
    const { initializeApp, cert, getApps } = require('firebase-admin/app');
    const { getFirestore } = require('firebase-admin/firestore');
    const { getAuth } = require('firebase-admin/auth');

    const app = getApps().length ? getApps()[0] : initializeApp({
      credential: cert({
        projectId: be.FIREBASE_PROJECT_ID,
        clientEmail: be.FIREBASE_CLIENT_EMAIL,
        privateKey: be.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    pass('Admin SDK initialised (credentials parsed)');

    // Firestore round trip — writes, reads and deletes a throwaway probe document.
    let credsRejected = false;
    try {
      const db = getFirestore(app);
      const ref = db.collection('_riderhub_doctor').doc('probe');
      await ref.set({ at: new Date().toISOString() });
      await ref.get();
      await ref.delete();
      pass('Firestore read/write works');
    } catch (e) {
      const [msg, fix] = diagnose(e);
      credsRejected = /Credentials rejected/.test(msg);
      fail(`Firestore: ${msg}`, fix);
    }

    // If the credentials themselves are bad, the next two checks add only noise.
    if (credsRejected) {
      warn('Auth check skipped — fix the credentials first');
    } else {
      try {
        await getAuth(app).listUsers(1);
        pass('Firebase Auth reachable');
      } catch (e) {
        const [msg, fix] = diagnose(e);
        fail(`Auth: ${msg}`, fix || 'Firebase Console → Build → Authentication → Get started');
      }
    }
  } catch (e) {
    const [msg, fix] = diagnose(e);
    fail(`Admin SDK init: ${msg}`, fix || 'Usually a mangled FIREBASE_PRIVATE_KEY — re-run npm run setup');
  }
}

// ── 6. Map tiles ───────────────────────────────────────────────
section('Map tiles (no key needed)');
try {
  const r = await fetch('https://tiles.openfreemap.org/styles/dark', { signal: AbortSignal.timeout(10000) });
  r.ok ? pass('OpenFreeMap reachable') : warn(`OpenFreeMap returned HTTP ${r.status}`, 'Map may not render; check again shortly');
} catch {
  warn('Could not reach OpenFreeMap', 'Offline? The map needs it on first load, then tiles are cached');
}

// ── Summary ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(52)}`);
if (failed === 0 && warned === 0) {
  console.log(`${c.green}${c.bold}All checks passed.${c.reset} Run ${c.cyan}npm run dev${c.reset}\n`);
} else if (failed === 0) {
  console.log(`${c.green}${c.bold}Ready.${c.reset} ${warned} warning(s) — optional things only.\nRun ${c.cyan}npm run dev${c.reset}\n`);
} else {
  console.log(`${c.red}${c.bold}${failed} problem(s) to fix${c.reset}${warned ? `, ${warned} warning(s)` : ''}.\nFix the ✗ items above and run ${c.cyan}npm run doctor${c.reset} again.\n`);
}
process.exit(failed === 0 ? 0 : 1);
