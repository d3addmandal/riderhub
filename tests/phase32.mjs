// Positioned elements must stay positioned, and buttons must look raised.
//
// The SOS button broke because `.btn3d { position: relative }` was defined after
// @tailwind utilities, so it outranked Tailwind's own `.fixed` and dropped the button
// into normal flow. These checks measure real geometry so that class of regression
// cannot come back quietly.
import puppeteer from 'puppeteer-core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , DIST, CHROME] = process.argv;
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const cssFile = readdirSync(join(DIST, 'assets')).find(f => f.endsWith('.css'));
const css = readFileSync(join(DIST, 'assets', cssFile), 'utf8');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;height:100%}</style></head><body>
  <div style="height:2000px"></div>
  <button id="sos" class="btn3d btn3d-danger fixed bottom-20 right-4 z-50 w-12 h-12 rounded-full
    bg-danger flex items-center justify-center text-ink font-black text-sm">SOS</button>
  <nav id="nav" class="fixed bottom-0 left-0 right-0 h-16 bg-surface border-t border-border z-40"></nav>
  <button id="raised" class="btn3d btn3d-accent bg-accent text-accent-ink rounded-xl px-4 py-2">Go</button>
  <button id="ghost" class="btn3d btn3d-surface bg-surface2 text-ink border border-border rounded-xl px-4 py-2">Ghost</button>
  <button id="plain" class="text-muted px-2">Link</button>
</body></html>`;

await page.setContent(html, { waitUntil: 'load' });

const info = id => page.evaluate(id => {
  const el = document.getElementById(id);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    position: cs.position, boxShadow: cs.boxShadow, backgroundImage: cs.backgroundImage,
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height,
  };
}, id);

console.log('\n=== THE SOS BUTTON IS WHERE IT BELONGS ===');
const sos = await info('sos');
const nav = await info('nav');
// The actual regression: btn3d must not steal `position` from Tailwind.
check('it is still position:fixed', sos.position === 'fixed', sos.position);
check('it sits on screen, not off the left edge', sos.left > 0, `left=${sos.left}`);
check('it is pinned to the right', Math.abs(390 - sos.right - 16) <= 1, `right edge gap=${390 - sos.right}`);
check('it clears the bottom nav', sos.bottom <= nav.top + 1,
  `sos.bottom=${sos.bottom} nav.top=${nav.top}`);
check('it is fully inside the viewport', sos.left >= 0 && sos.right <= 390 && sos.bottom <= 844,
  JSON.stringify({ l: sos.left, r: sos.right, b: sos.bottom }));
check('it keeps its round shape', Math.abs(sos.w - sos.h) < 1 && sos.w >= 44, `${sos.w}x${sos.h}`);

console.log('\n=== IT DOES NOT SCROLL AWAY ===');
await page.evaluate(() => window.scrollTo(0, 1200));
const after = await info('sos');
check('stays put when the page scrolls', Math.abs(after.top - sos.top) < 1,
  `${sos.top} -> ${after.top}`);
await page.evaluate(() => window.scrollTo(0, 0));

console.log('\n=== BUTTONS LOOK RAISED ===');
for (const [id, label] of [['sos', 'SOS'], ['raised', 'primary'], ['ghost', 'ghost']]) {
  const b = await info(id);
  // A hard edge is a shadow with no blur — the second length stays non-zero, the third is 0.
  check(`${label} has a solid bottom edge`, /0px 3px 0px 0px/.test(b.boxShadow), b.boxShadow?.slice(0, 60));
  check(`${label} has the top highlight`, b.backgroundImage.includes('linear-gradient'),
    b.backgroundImage?.slice(0, 40));
}
// Ghost used to be deliberately flat; the rider asked for every button to be raised.
const ghost = await info('ghost');
check('ghost is no longer flat', ghost.boxShadow !== 'none', ghost.boxShadow?.slice(0, 40));

console.log('\n=== PLAIN TEXT BUTTONS STAY FLAT ===');
// A text link with a lip would look wrong; only real buttons are raised.
const plain = await info('plain');
check('a text-only button has no edge', plain.boxShadow === 'none', plain.boxShadow);

console.log('\n=== HOVER AND PRESS MOVE IT ===');
const t = await page.evaluate(() => {
  const el = document.getElementById('raised');
  const base = getComputedStyle(el).transform;
  el.classList.add('hovertest');
  return { base };
});
check('at rest it is untransformed', t.base === 'none' || t.base === 'matrix(1, 0, 0, 1, 0, 0)', t.base);
// Hover cannot be forced from script, so assert the rule exists in the stylesheet.
check('a hover rule lifts the button', /\.btn3d:hover:not\(:disabled\)\{[^}]*translateY\(-1px\)/.test(css.replace(/\s/g, '')) || css.includes('translateY(-1px)'));
check('an active rule presses it down', css.includes('translateY(3px)'));

console.log('\n=== THE OLD BUG CANNOT RETURN ===');
// If anyone reintroduces `position` into .btn3d, every fixed/absolute button breaks again.
const rule = css.match(/\.btn3d\{[^}]*\}/);
check('btn3d declares no position', !!rule && !/position\s*:/.test(rule[0]), rule?.[0]?.slice(0, 80));
check('btn3d uses no ::after overlay', !/\.btn3d::after/.test(css));

await browser.close();
console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
