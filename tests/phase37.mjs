// Firebase Hosting readiness.
//
// Two modes:
//
//   Emulator  (default)  — drives `firebase emulators:start --config firebase.emutest.json`
//                          and asserts what a phone would receive: the shell, icons, that
//                          no source or env file is published, and that Firestore refuses
//                          direct client access.
//
//   Live      (pass an https:// URL) — the same checks against the real CDN, plus the
//                          response headers and deep-link rewrites, observed for real.
//
// Rewrites and headers under the emulator — a Windows-specific caveat
// --------------------------------------------------------------------
// The hosting emulator (superstatic) normalises every request path and every `source`
// glob with `glob-slasher`, which uses `path.join` and therefore produces backslashes on
// Windows: "/sw.js" becomes "\sw.js". A backslash is an escape character to minimatch and
// never equals "/" to a regex, so on Windows NO rewrite and NO header rule ever matches —
// deep links 404 and no custom header is emitted, while the very same config works on
// Linux/macOS and in production. Verified by tracing patterns.configMatcher: every
// comparison arrives as "\rides" vs "\**".
//
// So on Windows this file evaluates the rewrite and header rules through superstatic's
// own matcher, fed POSIX paths — the exact production code path minus the bug — and on
// other platforms it asserts them against the live emulator response. Either way the
// live site is the final word: `npm run test:hosting:prod` after deploying.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const HOST = process.argv[2] ?? 'http://[::1]:27350';
const FS = process.argv[3] ?? 'http://[::1]:27360';
const PROJECT = process.argv[4] ?? 'riderhub-test';
const LIVE = /^https:\/\//.test(HOST);
const WINDOWS_EMULATOR = !LIVE && process.platform === 'win32';

let pass = 0, fail = 0, skip = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));
const skipped = (n, why) => { skip++; console.log(`  SKIP  ${n} — ${why}`); };

const get = async (path) => {
  const r = await fetch(`${HOST}${path}`, { redirect: 'manual' });
  return { status: r.status, headers: r.headers, body: await r.text() };
};

console.log(`\nMode: ${LIVE ? 'LIVE site' : `emulator${WINDOWS_EMULATOR ? ' (Windows)' : ''}`} at ${HOST}`);

const cfg = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting;

/* ---------- superstatic's matcher, for the Windows path ---------- */
// Same function the emulator (and Firebase's reference implementation) uses to decide
// whether a glob or RE2 regex applies to a path. Looked up from the global
// firebase-tools install so nothing extra has to be installed for the test.
function loadMatcher() {
  const req = createRequire(import.meta.url);
  const candidates = ['superstatic/lib/utils/patterns'];
  try {
    const g = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    candidates.push(join(g, 'firebase-tools/node_modules/superstatic/lib/utils/patterns'));
  } catch { /* no global npm; fall through */ }
  for (const c of candidates) { try { return req(c).configMatcher; } catch { /* next */ } }
  return null;
}
const matchesRule = loadMatcher();
const firstRewrite = (path) => cfg.rewrites.find(rw => matchesRule(path, rw));
const headersFor = (path) => cfg.headers.filter(h => matchesRule(path, h))
  .flatMap(h => h.headers).reduce((o, h) => (o[h.key.toLowerCase()] = h.value, o), {});

console.log('\n=== THE SHELL IS SERVED ===');
const root = await get('/');
check('root serves the app', root.status === 200 && root.body.includes('<div id="root">'), `${root.status}`);
check('the manifest is linked from it', /rel="manifest"/.test(root.body));

console.log('\n=== DEEP LINKS SURVIVE A REFRESH ===');
// Without the SPA rewrite, refreshing /rides/abc on a phone returns a Firebase 404 page
// and the rider is stranded mid-ride. The API prefix must never be swallowed into
// index.html either: a misconfigured relative API URL would otherwise get the SPA shell
// back as its "JSON".
const DEEP = ['/rides', '/rides/abc123/map', '/garage', '/sos', '/profile'];
if (WINDOWS_EMULATOR) {
  if (!matchesRule) {
    skipped('rewrite rules', 'superstatic not found (is firebase-tools installed globally?)');
  } else {
    for (const p of DEEP) check(`${p} rewrites to the app`, firstRewrite(p)?.destination === '/index.html', 'no matching rewrite');
    for (const p of ['/api/', '/api/rides', '/api/config/maps']) check(`${p} goes to the API function, not the shell`, firstRewrite(p)?.function?.functionId === 'api', JSON.stringify(firstRewrite(p)));
    // Regressions of the "looks like /api" kind: these are app routes and must keep working.
    for (const p of ['/a', '/apple', '/apix']) check(`${p} still rewrites (not mistaken for /api)`, firstRewrite(p)?.destination === '/index.html');
  }
} else {
  for (const p of DEEP) {
    const r = await get(p);
    check(`${p} rewrites to the app`, r.status === 200 && r.body.includes('<div id="root">'), `${r.status}`);
  }
  const api = await get('/api/rides');
  check('/api/* is NOT rewritten to the shell', !api.body.includes('<div id="root">'), `status ${api.status}, served index.html`);
}
// If a regex rewrite is ever added it must be RE2-legal: production Hosting compiles it
// with RE2, which has no lookahead/lookbehind. A JS-only construct deploys and then 500s.
for (const rw of cfg.rewrites.filter(r => r.regex)) {
  check(`rewrite regex is RE2-safe (${rw.regex.slice(0, 24)}…)`, !/\(\?[=!<]/.test(rw.regex), 'contains lookaround');
}

console.log('\n=== ICONS SHIP WITH THE SITE ===');
for (const p of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png', '/apple-touch-icon.png']) {
  const r = await fetch(`${HOST}${p}`);
  const buf = Buffer.from(await r.arrayBuffer());
  check(`${p} is a real PNG`, r.status === 200 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG',
    `${r.status} ${buf.length}b`);
}
const man = await get('/manifest.webmanifest');
check('manifest is served', man.status === 200 && man.body.includes('"icons"'), `${man.status}`);

console.log('\n=== NOTHING SENSITIVE IS DEPLOYED ===');
// Hosting publishes the whole `public` directory; env files and source must not be in it.
for (const p of ['/.env', '/.env.production', '/vite.config.ts', '/src/main.tsx', '/package.json']) {
  const r = await get(p);
  const leaked = r.status === 200 && !r.body.includes('<div id="root">');
  check(`${p} is not published`, !leaked, 'served real content');
}

console.log('\n=== RESPONSE HEADERS ===');
const HEADER_RULES = [
  ['/sw.js', 'cache-control', /no-cache|no-store/, 'a cached service worker never updates'],
  ['/sw.js', 'service-worker-allowed', /^\/$/, 'the worker must control the whole origin'],
  ['/registerSW.js', 'cache-control', /no-cache|no-store/, 'the registration script must not be stale'],
  ['/manifest.webmanifest', 'content-type', /manifest\+json/, 'wrong type breaks install prompts'],
  ['/assets/index-abc123.js', 'cache-control', /max-age=31536000.*immutable/, 'hashed assets are safe to cache for a year'],
  ['/icons/icon-192.png', 'cache-control', /max-age=604800/, 'icons cached a week'],
  ['/rides/abc', 'cache-control', /no-cache|no-store/, 'a deep link serves the shell too'],
  ['/rides/abc', 'x-frame-options', /^DENY$/i, 'clickjacking'],
  ['/rides/abc', 'x-content-type-options', /^nosniff$/i, 'MIME sniffing'],
  ['/rides/abc', 'permissions-policy', /geolocation=\(self\)/, 'geolocation only for the app itself'],
  ['/sw.js', 'x-frame-options', /^DENY$/i, 'security headers also cover the worker'],
];
if (WINDOWS_EMULATOR) {
  if (!matchesRule) {
    skipped('header rules', 'superstatic not found');
  } else {
    for (const [path, name, re, why] of HEADER_RULES) {
      const v = headersFor(path)[name] ?? '';
      check(`${path} → ${name} (${why})`, re.test(v), v || '(no rule matches)');
    }
    // The shell itself: cleanUrls serves "/" from index.html, and the CDN applies the
    // rules for the resolved file. Both spellings must be no-cache.
    // Hosting matches on the request path, so the rule that matters is the one covering
  // "/" and every deep link - not one naming the file they are rewritten to.
  for (const p of ['/', '/index.html', '/rides', '/rides/abc/map'])
      check(`${p} → cache-control no-cache (a cached shell pins riders to old code)`,
        /no-cache|no-store/.test(headersFor(p)['cache-control'] ?? ''), headersFor(p)['cache-control'] ?? '(no rule matches)');
  }
} else {
  const livePath = (p) => p.startsWith('/assets/') ? (root.body.match(/\/assets\/[^"']+\.js/)?.[0] ?? p) : p;
  for (const [path, name, re, why] of HEADER_RULES) {
    const r = await get(livePath(path));
    const v = r.headers.get(name) ?? '';
    check(`${path} → ${name} (${why})`, re.test(v), v || '(absent)');
  }
  const shell = await get('/');
  check('/ → cache-control no-cache (a cached shell pins riders to old code)',
    /no-cache|no-store/.test(shell.headers.get('cache-control') ?? ''), shell.headers.get('cache-control') ?? '(absent)');
}
// The emulator config must stay in step with the real one, or local checks test the wrong thing.
const emu = JSON.parse(readFileSync('firebase.emutest.json', 'utf8')).hosting;
check('emulator config carries the same header rules as production',
  JSON.stringify(emu.headers) === JSON.stringify(cfg.headers), 'firebase.emutest.json drifted');
check('emulator config carries the same rewrites as production',
  JSON.stringify(emu.rewrites) === JSON.stringify(cfg.rewrites), 'firebase.emutest.json drifted');

console.log('\n=== FIRESTORE REFUSES DIRECT CLIENT ACCESS ===');
if (LIVE) {
  skipped('Firestore rules probe', 'only run against the emulator; the live database is not to be poked from a test');
} else {
  // An unsigned JWT is what the emulator accepts as a "client" identity. Even a signed-in
  // rider must be refused straight from the browser: every data path goes through the API,
  // and profiles hold medical data.
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const clientJwt = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    sub: 'rider-abc', user_id: 'rider-abc', aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'google.com', identities: {} },
  })}.`;
  const docs = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
  const asClient = (path, init = {}) => fetch(`${docs}${path}`, {
    ...init, headers: { Authorization: `Bearer ${clientJwt}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  check('a signed-in client cannot list profiles', (await asClient('/profiles')).status === 403);
  check('a client cannot even read its own profile directly', (await asClient('/profiles/rider-abc')).status === 403);
  const write = await asClient('/rides', { method: 'POST', body: JSON.stringify({ fields: { name: { stringValue: 'x' } } }) });
  check('a client cannot create a ride around the API', write.status === 403, `${write.status}`);
  check('an anonymous client is refused too', (await fetch(`${docs}/profiles`)).status === 403);
}

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}   SKIPPED: ${skip}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
