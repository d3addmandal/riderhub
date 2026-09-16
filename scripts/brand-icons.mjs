// Builds every icon the PWA needs from the two brand files in the project root:
//
//   icon.png  — the pegasus on a transparent background → launcher/home-screen icons
//   logo.png  — the round club badge                    → the loading (splash) screen
//
// Run it again whenever either file changes:  node scripts/brand-icons.mjs
//
// No native image library is installed, so headless Chrome does the resizing on a
// <canvas>. It is the same Chrome the browser tests use.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// puppeteer-core lives in the frontend's node_modules; resolve it from there.
const puppeteer = createRequire(join(ROOT, 'frontend', 'package.json'))('puppeteer-core');
const PUBLIC = join(ROOT, 'frontend', 'public');
const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(p => p && existsSync(p));
if (!CHROME) { console.error('Chrome not found; set CHROME=<path to chrome executable>'); process.exit(1); }

const dataUri = (f) => `data:image/png;base64,${readFileSync(join(ROOT, f)).toString('base64')}`;

// The dark ground is the manifest's background_color. Android paints its own splash
// with that colour behind the icon, and the HTML boot screen uses it too, so the icon,
// the system splash, and the in-page splash all read as one surface.
const GROUND = '#0f1117';

/*
 * Each output: name, canvas size, which source, how much of the canvas the artwork may
 * fill (as a fraction of the side), and the background (null = transparent).
 *
 *  - "any" icons stay transparent: Chrome's install dialog and desktop shortcuts show
 *    them as-is, and the pegasus's outline is the whole point.
 *  - maskable icons must keep everything important inside the inner 80 % circle,
 *    because launchers crop them to circles, squircles and teardrops. 0.6 leaves the
 *    wing tips safe on every shape Android uses.
 *  - iOS ignores the manifest and renders transparency as black, so the touch icon
 *    gets the ground painted in and iOS adds its own rounded corners.
 */
const OUTPUTS = [
  { out: 'icons/icon-192.png',          size: 192, src: 'icon.png', fill: 0.92, bg: null },
  { out: 'icons/icon-512.png',          size: 512, src: 'icon.png', fill: 0.92, bg: null },
  { out: 'icons/icon-192-maskable.png', size: 192, src: 'icon.png', fill: 0.60, bg: GROUND },
  { out: 'icons/icon-512-maskable.png', size: 512, src: 'icon.png', fill: 0.60, bg: GROUND },
  { out: 'apple-touch-icon.png',        size: 180, src: 'icon.png', fill: 0.80, bg: GROUND },
  { out: 'favicon.png',                 size: 64,  src: 'icon.png', fill: 1.00, bg: null },
  // The splash badge: crisp on a 3× phone at ~240 CSS px. As PNG this is ~900 KB,
  // which would slow the very first load it exists to cover; as WebP (alpha kept) it
  // is under 100 KB. Every browser that can install a PWA decodes WebP.
  { out: 'logo.webp',                   size: 640, src: 'logo.png', fill: 1.00, bg: null, type: 'image/webp', quality: 0.86 },
];

const html = `<!doctype html><body>
<img id="icon" src="${dataUri('icon.png')}"><img id="logo" src="${dataUri('logo.png')}">
<script>
window.render = async (spec) => {
  const img = document.getElementById(spec.src === 'icon.png' ? 'icon' : 'logo');
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = spec.size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if (spec.bg) { ctx.fillStyle = spec.bg; ctx.fillRect(0, 0, spec.size, spec.size); }
  // Fit the artwork inside a centred square of side size*fill, preserving aspect.
  const box = spec.size * spec.fill;
  const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  // Downscale in two steps for anything shrinking more than 2×: a single step from
  // 1289 px to 64 px aliases the feather edges into noise.
  let source = img, sw = img.naturalWidth, sh = img.naturalHeight;
  while (sw / w > 2) {
    const tmp = document.createElement('canvas'); tmp.width = Math.ceil(sw / 2); tmp.height = Math.ceil(sh / 2);
    const t = tmp.getContext('2d'); t.imageSmoothingQuality = 'high';
    t.drawImage(source, 0, 0, tmp.width, tmp.height);
    source = tmp; sw = tmp.width; sh = tmp.height;
  }
  ctx.drawImage(source, (spec.size - w) / 2, (spec.size - h) / 2, w, h);
  return c.toDataURL(spec.type ?? 'image/png', spec.quality);
};
</script></body>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
mkdirSync(join(PUBLIC, 'icons'), { recursive: true });
for (const spec of OUTPUTS) {
  const url = await page.evaluate((s) => window.render(s), spec);
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  writeFileSync(join(PUBLIC, spec.out), bytes);
  console.log(`  ${spec.out.padEnd(30)} ${spec.size}px  ${(bytes.length / 1024).toFixed(0).padStart(4)} KB`);
}
await browser.close();
console.log('\nIcons written to frontend/public. Rebuild the frontend to ship them.');
