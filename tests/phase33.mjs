// Link-styled buttons, and the floating SOS not sitting on top of anything tappable.
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

// The dashboard shape: a scrolling page inside main, the nav, and the floating SOS.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body,#root{margin:0;height:100%}</style></head><body>
<div id="root" class="flex flex-col h-full bg-bg overflow-hidden">
  <main class="flex-1 overflow-hidden pb-16">
    <div class="h-full overflow-y-auto scroll-y">
      <div class="p-4 flex flex-col gap-4">
        <div style="height:900px"></div>
        <div class="grid grid-cols-4 gap-2">
          ${['Fuel', 'Service', 'Ride', 'Bike'].map((l, i) => `
            <a href="#" id="quick${i}">
              <div class="btn3d btn3d-surface bg-surface2 border border-border rounded-xl h-11
                          flex items-center justify-center text-xs font-semibold text-ink">${l}</div>
            </a>`).join('')}
        </div>
      </div>
    </div>
  </main>
  <nav id="nav" class="fixed bottom-0 left-0 right-0 h-16 bg-surface border-t border-border z-40"></nav>
  <button id="sos" class="btn3d btn3d-danger fixed bottom-20 right-4 z-50 w-12 h-12 rounded-full
    bg-danger flex items-center justify-center text-ink font-black text-sm">SOS</button>
</div></body></html>`;

await page.setContent(html, { waitUntil: 'load' });
// Scroll to the bottom, where the quick actions live.
await page.evaluate(() => {
  const sc = document.querySelector('main .scroll-y');
  sc.scrollTop = sc.scrollHeight;
});
await new Promise(r => setTimeout(r, 150));

const box = id => page.evaluate(id => {
  const el = document.getElementById(id);
  if (!el) return null;
  const t = el.firstElementChild ?? el;
  const cs = getComputedStyle(t);
  const r = el.getBoundingClientRect();
  return {
    boxShadow: cs.boxShadow, backgroundImage: cs.backgroundImage,
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height,
  };
}, id);

console.log('\n=== THE QUICK ACTIONS ARE RAISED ===');
for (let i = 0; i < 4; i++) {
  const b = await box(`quick${i}`);
  check(`quick action ${i + 1} has a solid bottom edge`, /0px 3px 0px 0px/.test(b.boxShadow),
    b.boxShadow?.slice(0, 45));
  check(`quick action ${i + 1} has the top highlight`, b.backgroundImage.includes('linear-gradient'));
}

console.log('\n=== NOTHING TAPPABLE HIDES UNDER THE SOS BUTTON ===');
const sos = await box('sos');
const overlaps = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

for (let i = 0; i < 4; i++) {
  const q = await box(`quick${i}`);
  // This is the reported bug: SOS was sitting squarely on the Bike shortcut.
  check(`quick action ${i + 1} is not covered by SOS`, !overlaps(sos, q),
    `sos[${sos.left.toFixed(0)},${sos.top.toFixed(0)}-${sos.right.toFixed(0)},${sos.bottom.toFixed(0)}] `
    + `vs [${q.left.toFixed(0)},${q.top.toFixed(0)}-${q.right.toFixed(0)},${q.bottom.toFixed(0)}]`);
}

// And what is actually on top at the SOS centre should be the SOS button itself.
const onTop = await page.evaluate(() => {
  const s = document.getElementById('sos').getBoundingClientRect();
  const el = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
  return el?.id || el?.tagName;
});
check('SOS is the topmost thing at its own centre', onTop === 'sos', String(onTop));

console.log('\n=== THE CLEARANCE RULE IS IN THE STYLESHEET ===');
check('page scrollers reserve room below the fold',
  css.includes('main>.scroll-y>:first-child') || css.includes('main > .scroll-y > :first-child'),
  'rule missing');

const scrolled = await page.evaluate(() => {
  const sc = document.querySelector('main .scroll-y');
  return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
});
check('the page really is scrolled to the bottom', scrolled.top >= scrolled.max - 1,
  `${scrolled.top}/${scrolled.max}`);

await browser.close();
console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
