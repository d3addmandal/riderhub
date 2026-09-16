// No credential may reach the browser bundle except the ones that are public by design.
//
// Run against a fresh `npm run build`. This is a guard rail: it fails loudly if anyone
// later reintroduces a key into the frontend, which is exactly the kind of change that
// slips through review because the app keeps working.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? '.';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

function env(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...rest] = t.split('=');
    const v = rest.join('=').trim().replace(/^"|"$/g, '');
    if (v) out[k.trim()] = v;
  }
  return out;
}

const be = env(join(ROOT, 'backend/.env'));
// Both frontend env files: .env.production is what a hosted build actually reads, so a
// secret pasted there would ship even though .env looked clean.
const fe = { ...env(join(ROOT, 'frontend/.env')), ...env(join(ROOT, 'frontend/.env.production')) };

const dist = join(ROOT, 'frontend/dist/assets');
const bundle = existsSync(dist)
  ? readdirSync(dist).filter(f => f.endsWith('.js'))
      .map(f => readFileSync(join(dist, f), 'utf8')).join('\n')
  : '';

console.log('\n=== THE BUNDLE EXISTS ===');
check('a built bundle was found', bundle.length > 1000, `${bundle.length} bytes`);

console.log('\n=== SERVER SECRETS NEVER REACH THE BROWSER ===');
// These would let someone impersonate the backend, drain the Maps quota, or drive the bot.
for (const k of ['FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'TELEGRAM_BOT_TOKEN',
                 'GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY']) {
  const v = be[k];
  if (!v) { console.log(`  SKIP  ${k} not set`); continue; }
  // A private key is multi-line; check a distinctive slice of it.
  const needle = v.length > 60 ? v.slice(20, 80) : v;
  check(`${k} is absent from the bundle`, !bundle.includes(needle));
}

console.log('\n=== THE MAPS KEY IS NOT IN THE FRONTEND AT ALL ===');
check('no VITE_GOOGLE_MAPS_API_KEY in frontend/.env', !('VITE_GOOGLE_MAPS_API_KEY' in fe),
  Object.keys(fe).filter(k => k.includes('MAPS')).join());
check('no VITE_GOOGLE_MAPS_MAP_ID in frontend/.env', !('VITE_GOOGLE_MAPS_MAP_ID' in fe));
check('the frontend source no longer reads a Maps key from the bundle',
  !readFileSync(join(ROOT, 'frontend/src/lib/googleMaps.ts'), 'utf8')
     .includes('import.meta.env.VITE_GOOGLE_MAPS'));
check('it fetches the key from the API instead',
  readFileSync(join(ROOT, 'frontend/src/lib/googleMaps.ts'), 'utf8').includes('/config/maps'));

console.log('\n=== ONLY PUBLIC-BY-DESIGN VALUES REMAIN ===');
/*
 * Firebase web config is not a secret. Google documents it as an identifier: the browser
 * cannot reach Auth or Firestore without it, and access is controlled by Firestore rules
 * and Auth, not by hiding these values. They are expected in the bundle. Anything NOT on
 * this list appearing in the bundle is a real finding.
 */
const PUBLIC_BY_DESIGN = new Set([
  'VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID',
  'VITE_TELEGRAM_BOT_USERNAME',   // a @username, not a token
  'VITE_API_URL',                 // where to send requests
  'FIREBASE_PROJECT_ID',          // same project id as the VITE_ one above
]);

const unexpected = [];
for (const [k, v] of Object.entries({ ...be, ...fe })) {
  if (v.length < 12) continue;
  const needle = v.length > 60 ? v.slice(20, 80) : v;
  if (bundle.includes(needle) && !PUBLIC_BY_DESIGN.has(k)) unexpected.push(k);
}
check('nothing unexpected is embedded', unexpected.length === 0, unexpected.join(', '));

console.log('\n=== THE ENDPOINT THAT SERVES THE KEY IS PROTECTED ===');
const cfg = readFileSync(join(ROOT, 'backend/src/routes/config.ts'), 'utf8');
check('the maps config route requires auth', /router\.get\('\/maps',\s*requireAuth/.test(cfg));
check('and is not cached by proxies', cfg.includes('no-store'));

console.log('\n=== SECRETS CANNOT BE COMMITTED ===');
const gi = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
check('.gitignore exists', gi.length > 0);
check('it ignores .env', /^\.env$/m.test(gi));
check('it ignores backend/.env', gi.includes('backend/.env'));
check('it ignores frontend/.env', gi.includes('frontend/.env'));

console.log('\n=== EXAMPLES CARRY NO REAL VALUES ===');
for (const f of ['backend/.env.example', 'frontend/.env.example']) {
  const p = join(ROOT, f);
  if (!existsSync(p)) { console.log(`  SKIP  ${f} missing`); continue; }
  const text = readFileSync(p, 'utf8');
  /*
   * Only genuinely secret values matter here. A localhost URL is a legitimate example
   * default and belongs in the file; flagging it would train people to ignore this check.
   */
  const SECRET_KEYS = [
    'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'TELEGRAM_BOT_TOKEN',
    'GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_APP_ID', 'JWT_SECRET',
  ];
  const all = { ...be, ...fe };
  const real = SECRET_KEYS.filter(k => all[k] && all[k].length >= 12 && text.includes(all[k]));
  check(`${f} holds no real credential`, real.length === 0, real.join(', '));
}

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
