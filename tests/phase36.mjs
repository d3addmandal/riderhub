// PWA installability, checked against the criteria Chrome actually applies.
//
// The app was configured as a PWA from the start but declared icon files that did not
// exist, so it could never be installed. These checks assert the built output, not the
// config — a manifest that points at a missing file looks perfectly correct in source.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8'));
const html = readFileSync(join(DIST, 'index.html'), 'utf8');

console.log('\n=== THE MANIFEST IS SERVED AND LINKED ===');
check('a manifest is emitted', !!manifest.name);
check('the page links it', /rel="manifest"/.test(html));
check('the service worker is registered', /registerSW\.js|serviceWorker/.test(html));
check('a service worker is emitted', existsSync(join(DIST, 'sw.js')));

console.log('\n=== CHROME INSTALLABILITY CRITERIA ===');
// Chrome requires: name, start_url, display, and icons at 192 and 512.
check('has a name', !!manifest.name, manifest.name);
check('has a short_name for the launcher', !!manifest.short_name, manifest.short_name);
check('has a start_url', !!manifest.start_url, manifest.start_url);
check('has a scope so links stay in-app', !!manifest.scope, manifest.scope);
check('display is standalone', manifest.display === 'standalone', manifest.display);
check('has a theme colour', /^#[0-9a-f]{6}$/i.test(manifest.theme_color ?? ''), manifest.theme_color);
check('has a background colour for the splash', /^#[0-9a-f]{6}$/i.test(manifest.background_color ?? ''),
  manifest.background_color);

const sizes = (manifest.icons ?? []).map(i => i.sizes);
check('declares a 192px icon', sizes.includes('192x192'), sizes.join(' '));
check('declares a 512px icon', sizes.includes('512x512'), sizes.join(' '));

console.log('\n=== EVERY DECLARED ICON ACTUALLY EXISTS ===');
// This is the failure that blocked installation: files declared but never created.
for (const icon of manifest.icons ?? []) {
  const p = join(DIST, icon.src);
  const there = existsSync(p);
  check(`${icon.src} (${icon.purpose}) is present`, there, 'file missing');
  if (there) {
    const bytes = statSync(p).size;
    // A zero-length or near-empty PNG passes an existence check and still renders blank.
    check(`${icon.src} has real content`, bytes > 500, `${bytes} bytes`);
    const buf = readFileSync(p);
    check(`${icon.src} is a real PNG`,
      buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG', buf.toString('hex', 0, 4));
  }
}

console.log('\n=== ANDROID AND iOS SPECIFICS ===');
// Without a maskable icon Android letterboxes the square one inside a white circle.
check('a maskable icon is declared',
  (manifest.icons ?? []).some(i => (i.purpose ?? '').includes('maskable')));
// iOS ignores the manifest entirely and reads this tag.
check('the page links an apple-touch-icon', /rel="apple-touch-icon"/.test(html));
check('the apple-touch-icon file exists', existsSync(join(DIST, 'apple-touch-icon.png')));
check('iOS standalone meta is present', /apple-mobile-web-app-capable/.test(html));
check('the favicon is a png that exists',
  /rel="icon"[^>]*favicon\.png/.test(html) && existsSync(join(DIST, 'favicon.png')));
// A mismatched type stops some browsers using the icon at all.
check('the favicon link declares the right type', /rel="icon"[^>]*type="image\/png"/.test(html),
  html.match(/<link rel="icon"[^>]*>/)?.[0]);

console.log('\n=== ORIENTATION MATCHES THE APP ===');
// The map has a Rotate control and a landscape layout; a portrait lock contradicts both.
check('not locked to portrait', manifest.orientation !== 'portrait', manifest.orientation);

console.log('\n=== THE SERVICE WORKER PRECACHES THE SHELL ===');
const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
const wbFile = readdirSync(join(DIST)).find(f => f.startsWith('workbox-'));
check('workbox runtime shipped', !!wbFile, wbFile);
// The worker is minified, so keys are unquoted: {url:"...",revision:"..."}.
const entries = (sw.match(/revision:/g) ?? []).length;
check('the precache manifest is non-trivial', entries >= 5, `${entries} entries`);
check('the icons are precached', sw.includes('icon-512') || sw.includes('icons/'), 'icons absent');

console.log('\n=== THE BADGE IS ON SCREEN WHILE THE APP LOADS ===');
// The boot screen is plain HTML inside #root: it is painted before the bundle arrives
// and React replaces it on first render. If it ever moves outside #root it would sit
// on top of the app forever; if the image path breaks, riders get a blank dark screen.
check('index.html carries a boot screen inside #root',
  /<div id="root">\s*<div class="boot"/.test(html), 'boot screen missing or outside #root');
check('the boot screen shows the club badge', /class="boot"[^>]*>\s*<img src="\/logo\.webp"/.test(html));
check('the badge file is shipped', existsSync(join(DIST, 'logo.webp')));
check('the badge is a real WebP', existsSync(join(DIST, 'logo.webp')) &&
  readFileSync(join(DIST, 'logo.webp')).toString('ascii', 8, 12) === 'WEBP');
check('the badge is small enough not to delay first paint',
  existsSync(join(DIST, 'logo.webp')) && statSync(join(DIST, 'logo.webp')).size < 250 * 1024);
check('the badge is precached for offline starts', sw.includes('logo.webp'));
check('the boot ground matches the manifest background_color',
  html.includes(`background: ${manifest.background_color}`), manifest.background_color);
// API calls must never be served the app shell by the navigation fallback.
check('API routes are excluded from the navigation fallback',
  sw.includes('api') || readFileSync('vite.config.ts', 'utf8').includes('navigateFallbackDenylist'));

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
