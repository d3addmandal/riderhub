// The API runs as a Cloud Function behind Firebase Hosting.
//
// What can go wrong silently: the app grows a `listen()` again and the function hangs;
// the rewrite order flips and /api/* is swallowed by the SPA shell; a secret the routes
// need is not bound to the function and Maps calls fail only in production; the Admin
// SDK insists on a private key that does not exist inside Functions. Each of those is
// asserted here, partly by reading source and config, partly by loading the built
// function the way the runtime does.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));
const read = (p) => existsSync(p) ? readFileSync(p, 'utf8') : '';

console.log('\n=== HOSTING HANDS /api TO THE FUNCTION ===');
const fb = JSON.parse(read('firebase.json'));
const rw = fb.hosting.rewrites;
check('the first rewrite is /api/** → function "api"', rw[0]?.source === '/api/**' && rw[0]?.function?.functionId === 'api', JSON.stringify(rw[0]));
check('it names the region (Hosting cannot guess a non-default one)', rw[0]?.function?.region === 'asia-south1');
check('the SPA catch-all comes AFTER it', rw.findIndex(r => r.source === '**' && r.destination === '/index.html') > 0);
check('no rewrite still uses the old regex exclusion', !rw.some(r => r.regex));
check('functions source is the backend', fb.functions?.source === 'backend');
check('runtime is Node 22 (matches backend engines)', fb.functions?.runtime === 'nodejs22' && JSON.parse(read('backend/package.json')).engines?.node === '22');
check('the backend is compiled before upload', (fb.functions?.predeploy ?? []).some(c => /npm --prefix backend run build/.test(c)));
check('emulator config mirrors the rewrites', JSON.stringify(JSON.parse(read('firebase.emutest.json')).hosting.rewrites) === JSON.stringify(rw));

console.log('\n=== THE APP IS A FUNCTION, NOT A SERVER ===');
const app = read('backend/src/app.ts'), fn = read('backend/src/function.ts'), idx = read('backend/src/index.ts');
check('app.ts never listens on a port', !/\.listen\(/.test(app));
check('only the local index.ts listens', /app\.listen\(/.test(idx));
check('function.ts wraps the app with onRequest', /onRequest\(/.test(fn) && /from '\.\/app'/.test(fn));
check('the function is deployed to asia-south1', /region:\s*'asia-south1'/.test(fn));
check('package.json main points Cloud Functions at the function entry', JSON.parse(read('backend/package.json')).main === 'dist/function.js');
check('firebase-functions is a runtime dependency', Boolean(JSON.parse(read('backend/package.json')).dependencies['firebase-functions']));
check('the proxy is trusted only inside Cloud Run (K_SERVICE)', /K_SERVICE.*trust proxy/.test(app));
check('rate limiters accept the trusted proxy without per-request errors', (read('backend/src/middleware/security.ts').match(/validate:\s*\{\s*trustProxy:\s*false\s*\}/g) ?? []).length === 2);

console.log('\n=== EVERY SECRET THE ROUTES READ IS BOUND TO THE FUNCTION ===');
for (const s of ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'TELEGRAM_BOT_TOKEN']) {
  check(`${s} is declared with defineSecret`, fn.includes(`defineSecret('${s}')`));
}
const envFile = read('backend/.env.fly-with-pegasus');
check('the committed env file carries no secret-shaped value',
  !/(KEY|TOKEN|SECRET|PRIVATE)[A-Z_]*=\S+/.test(envFile.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')), 'a value is set on a KEY/TOKEN line');
check('the committed env file is not gitignored', !/\.env\.fly-with-pegasus|\.env\.\*$/m.test(read('.gitignore')));

console.log('\n=== THE ADMIN SDK WORKS WITHOUT A PRIVATE KEY INSIDE FUNCTIONS ===');
const cfg = read('backend/src/config/firebase.ts');
check('it detects the Functions runtime', /K_SERVICE|FUNCTION_TARGET|FIREBASE_CONFIG/.test(cfg));
check('it uses Application Default Credentials there', /runningInFunctions[\s\S]*initializeApp\(\)/.test(cfg));
check('it takes the project id from the runtime', /GCLOUD_PROJECT/.test(cfg));

console.log('\n=== THE BUILT FUNCTION LOADS THE WAY THE RUNTIME LOADS IT ===');
if (!existsSync('backend/dist/function.js')) {
  check('backend is built (npm --prefix backend run build)', false, 'backend/dist/function.js missing');
} else {
  // Load with the environment Cloud Functions provides and NONE of the dev-machine
  // variables. If module load throws, so does every cold start.
  const probe = `
    const m = require('./backend/dist/function.js');
    const ep = m.api && m.api.__endpoint;
    console.log(JSON.stringify({ isFn: typeof m.api === 'function', region: ep && ep.region, secrets: ep && (ep.secretEnvironmentVariables || []).map(s => s.key), listening: false }));
  `;
  const r = spawnSync(process.execPath, ['-e', probe], {
    env: { PATH: process.env.PATH, K_SERVICE: 'api', FUNCTION_TARGET: 'api', GCLOUD_PROJECT: 'fly-with-pegasus',
           FIREBASE_CONFIG: JSON.stringify({ projectId: 'fly-with-pegasus' }) },
    encoding: 'utf8', timeout: 30000,
  });
  const out = (() => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } })();
  check('module loads with no FIREBASE_* credentials in the environment', r.status === 0 && out, (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? `exit ${r.status}`);
  check('it exports `api` as a request handler', out?.isFn === true);
  check('the handler is registered for asia-south1', Array.isArray(out?.region) ? out.region.includes('asia-south1') : out?.region === 'asia-south1', JSON.stringify(out?.region));
  for (const s of ['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BROWSER_KEY', 'TELEGRAM_BOT_TOKEN']) {
    check(`${s} is bound at runtime`, (out?.secrets ?? []).includes(s));
  }
  check('loading the module opens no port', r.status === 0 && !/EADDRINUSE|API running on port/.test(r.stdout + r.stderr));
}

console.log('\n=== NOTHING DEPENDS ON A LONG-LIVED CONNECTION ===');
// Imports only — a comment explaining why there is no Socket.IO is not a dependency.
const grep = (dir) => {
  const hits = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && /from ['"]socket\.io/.test(readFileSync(p, 'utf8'))) hits.push(p);
  } };
  walk(dir);
  return hits.join(', ');
};
check('backend has no Socket.IO code', grep('backend/src') === '' && !JSON.parse(read('backend/package.json')).dependencies['socket.io'], grep('backend/src'));
check('frontend has no Socket.IO code', grep('frontend/src') === '' && !JSON.parse(read('frontend/package.json')).dependencies['socket.io-client'], grep('frontend/src'));

console.log('\n=== THE SITE CALLS THE API ON ITS OWN ORIGIN ===');
check('frontend/.env.production leaves VITE_API_URL empty', /^VITE_API_URL=\s*$/m.test(read('frontend/.env.production')));
check('the API client prefixes /api itself, so an empty base is same-origin', read('frontend/src/lib/api.ts').includes('${API_URL}/api${path}'));

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
