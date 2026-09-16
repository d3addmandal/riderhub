#!/usr/bin/env node
/**
 * RiderHub interactive setup.
 *
 * Turns the two things you download from the Firebase console — the service account
 * JSON and the web app config — into backend/.env and frontend/.env.
 *
 *   npm run setup
 */
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = m => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = m => console.log(`${c.yellow}!${c.reset} ${m}`);
const err = m => console.log(`${c.red}✗${c.reset} ${m}`);
const head = m => console.log(`\n${c.bold}${c.cyan}${m}${c.reset}\n${'─'.repeat(m.length)}`);

/**
 * Line reader built on a pull queue rather than rl.question().
 * question() is unreliable when stdin is a pipe rather than a terminal, which makes
 * the script impossible to test or script non-interactively.
 */
const rl = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });

const pending = [];   // lines read but not yet consumed
const waiters = [];   // consumers waiting for a line
let ended = false;

rl.on('line', line => {
  const w = waiters.shift();
  if (w) w(line); else pending.push(line);
});
rl.on('close', () => {
  ended = true;
  while (waiters.length) waiters.shift()(null);
});

function nextLine() {
  if (pending.length) return Promise.resolve(pending.shift());
  if (ended) return Promise.resolve(null);
  return new Promise(res => waiters.push(res));
}

async function askRaw(q) {
  if (q) process.stdout.write(q);
  return nextLine();
}

const ask = async q => {
  const a = await askRaw(q);
  if (a === null) { console.log('\nInput ended unexpectedly. Aborting.'); process.exit(1); }
  return a.trim();
};

/**
 * Read a multi-line paste, stopping once braces balance.
 * Uses the same question() mechanism as ask() — attaching a separate 'line' listener
 * fights with readline's question mode and silently swallows input.
 */
async function askBlock(q) {
  console.log(q);
  let buf = '', depth = 0, started = false;
  for (;;) {
    const line = await askRaw('');
    if (line === null) return buf;           // EOF — hand back whatever we got
    buf += line + '\n';
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }
    if (started && depth <= 0) return buf;
    if (!started && line.trim() === '' && buf.trim() !== '') return buf;
  }
}

/** Pull "key: 'value'" out of a pasted JS/JSON config without eval'ing it. */
function pick(block, key) {
  const m = block.match(new RegExp(`["']?${key}["']?\\s*:\\s*["\`']([^"\`']+)["\`']`));
  return m ? m[1] : '';
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '').trim();
}

function backup(path) {
  if (existsSync(path)) {
    copyFileSync(path, path + '.bak');
    warn(`Existing ${path.replace(ROOT + '\\', '').replace(ROOT + '/', '')} backed up to .env.bak`);
  }
}

console.log(`${c.bold}
🏍️  RiderHub — Setup
${c.reset}${c.dim}Writes backend/.env and frontend/.env from your Firebase credentials.
Nothing leaves this machine.${c.reset}`);

head('Step 1 of 4 — Service account (backend credentials)');
console.log(`${c.dim}Firebase Console → ⚙ Project settings → Service accounts →
"Generate new private key" → downloads a .json file.${c.reset}\n`);

let sa = null;
while (!sa) {
  const p = stripQuotes(await ask('Path to the downloaded .json file: '));
  if (!p) { err('Path required.'); continue; }
  if (!existsSync(p)) { err(`No file at: ${p}`); continue; }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      err('That JSON is missing project_id / client_email / private_key. Is it the service account key?');
      continue;
    }
    sa = parsed;
    ok(`Loaded service account for project "${sa.project_id}"`);
  } catch (e) {
    err(`Could not parse JSON: ${e.message}`);
  }
}

head('Step 2 of 4 — Web app config (frontend)');
console.log(`${c.dim}Firebase Console → ⚙ Project settings → General → Your apps → Web app
→ "SDK setup and configuration" → Config. Paste the whole block including braces.${c.reset}`);

let web = null;
while (!web) {
  const block = await askBlock(`\n${c.bold}Paste config, then press Enter:${c.reset}`);
  const cfg = {
    apiKey: pick(block, 'apiKey'),
    authDomain: pick(block, 'authDomain'),
    projectId: pick(block, 'projectId'),
    messagingSenderId: pick(block, 'messagingSenderId'),
    appId: pick(block, 'appId'),
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) { err(`Could not find: ${missing.join(', ')} — try pasting again.`); continue; }
  web = cfg;
  ok(`Web config read for project "${web.projectId}"`);
}

if (web.projectId !== sa.project_id) {
  warn(`Project mismatch! service account = "${sa.project_id}", web config = "${web.projectId}".`);
  const go = await ask('These should normally match. Continue anyway? (y/N): ');
  if (go.toLowerCase() !== 'y') { console.log('Aborted.'); rl.close(); process.exit(1); }
}

head('Step 3 of 4 — Optional extras');
console.log(`${c.dim}Telegram powers SOS alerts and reminders. Press Enter to skip — the app
runs fine without it, those notifications just stay off.${c.reset}`);
const telegram = await ask('Telegram bot token (optional): ');

const apiUrl = (await ask('Backend API URL [http://localhost:3001]: ')) || 'http://localhost:3001';
const frontUrl = (await ask('Frontend URL for CORS [http://localhost:5173]: ')) || 'http://localhost:5173';

head('Step 4 of 4 — Writing files');

// Keep the literal \n escapes; backend/src/config/firebase.ts converts them back.
const escapedKey = sa.private_key.replace(/\n/g, '\\n');

const backendEnv = `PORT=3001

# ── Firebase Admin ────────────────────────────────────────────
# Generated by \`npm run setup\`. Treat this file as a secret.
FIREBASE_PROJECT_ID=${sa.project_id}
FIREBASE_CLIENT_EMAIL=${sa.client_email}
FIREBASE_PRIVATE_KEY="${escapedKey}"

# ── Telegram Bot ──────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=${telegram}

# ── CORS ──────────────────────────────────────────────────────
FRONTEND_URL=${frontUrl}
`;

const frontendEnv = `# Generated by \`npm run setup\`.
# These are public by design — the web API key identifies the project, it does not
# grant access. Security comes from Firebase Auth + firestore.rules.
VITE_FIREBASE_API_KEY=${web.apiKey}
VITE_FIREBASE_AUTH_DOMAIN=${web.authDomain}
VITE_FIREBASE_PROJECT_ID=${web.projectId}
VITE_FIREBASE_MESSAGING_SENDER_ID=${web.messagingSenderId}
VITE_FIREBASE_APP_ID=${web.appId}

# Maps need no key — MapLibre GL JS renders OpenFreeMap's OpenStreetMap tiles.
VITE_API_URL=${apiUrl}
`;

const bePath = join(ROOT, 'backend', '.env');
const fePath = join(ROOT, 'frontend', '.env');
backup(bePath); backup(fePath);
writeFileSync(bePath, backendEnv, 'utf8');
writeFileSync(fePath, frontendEnv, 'utf8');
ok('Wrote backend/.env');
ok('Wrote frontend/.env');

console.log(`\n${c.bold}${c.green}Setup written.${c.reset}

${c.bold}Next:${c.reset}
  ${c.cyan}npm run doctor${c.reset}        verify the credentials actually work
  ${c.cyan}npm run deploy:rules${c.reset}  push firestore.rules and indexes
  ${c.cyan}npm run dev${c.reset}           start backend + frontend together

${c.dim}Still to do in the Firebase console (see SETUP.md §1):
  • Authentication → enable Google, and Email/Password with "Email link" turned on
  • Firestore Database → create (production mode)

No Cloud Storage needed — the app stays on the free Spark plan.${c.reset}
`);

rl.close();
