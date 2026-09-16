// The landscape bug, measured rather than eyeballed.
//
// The panel is anchored to the bottom of the map. With uncapped content on a sideways
// phone it grew off the top of the screen, taking the route-profile chips and the top
// bar with it, unreachable. These checks render the real stylesheet at real phone sizes
// and assert nothing escapes the viewport.
import puppeteer from 'puppeteer-core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , DIST, CHROME] = process.argv;
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const cssFile = readdirSync(join(DIST, 'assets')).find(f => f.endsWith('.css'));
const css = readFileSync(join(DIST, 'assets', cssFile), 'utf8');

// The panel and top bar as the map page renders them, with tall content inside.
const page$ = (rows) => `
<div id="stage" style="position:relative;width:100%;height:100%;overflow:hidden">
  <div id="topbar" class="absolute top-0 left-0 right-0 z-20 flex items-center gap-1.5 px-2 py-2
       bg-surface/90 backdrop-blur border-b border-border safe-top">
    <span class="text-ink text-sm font-bold">Ride</span>
  </div>
  <div id="panel" class="absolute bottom-0 left-0 right-0 z-20 bg-surface/95 backdrop-blur
       border-t border-border safe-bottom max-h-[62vh] short:max-h-[calc(100dvh-3.5rem)]
       overflow-y-auto scroll-y overscroll-contain">
    <div class="p-3 short:p-2 flex flex-col gap-3 short:gap-2">
      <div id="modes" class="flex gap-2">
        <button class="flex-1 bg-accent border-accent text-accent-ink rounded-xl py-2 text-xs font-semibold">General</button>
        <button class="flex-1 bg-surface2 border-border text-muted rounded-xl py-2 text-xs font-semibold">Bike</button>
        <button class="flex-1 bg-surface2 border-border text-muted rounded-xl py-2 text-xs font-semibold">Car</button>
      </div>
      ${Array.from({ length: rows }, (_, i) =>
        `<div class="bg-surface2 rounded-xl p-3 text-ink text-sm">Row ${i + 1}</div>`).join('')}
    </div>
  </div>
</div>`;

const nav = `
<nav id="footer" class="fixed bottom-0 left-0 right-0 h-16 short:h-12 bg-surface border-t
     border-border flex items-center gap-1 px-2 z-40 safe-bottom">
  ${['Home', 'Garage', 'Rides', 'Fuel', 'Service'].map((l, i) =>
    `<a class="flex-1 h-11 short:h-9 rounded-xl flex items-center justify-center text-xs font-semibold
        ${i === 2 ? 'bg-accent text-accent-ink' : 'bg-surface2 text-muted'}">${l}</a>`).join('')}
</nav>`;

const html = (body, theme) => `<!doctype html><html${theme ? ` data-theme="${theme}"` : ''}>
<head><meta charset="utf-8"><style>${css}
html,body{margin:0;height:100%}</style></head><body>${body}</body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();

const box = id => page.evaluate(id => {
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    top: r.top, bottom: r.bottom, height: r.height,
    scrollH: el.scrollHeight, clientH: el.clientHeight,
    overflowY: cs.overflowY, bg: cs.backgroundColor,
  };
}, id);

for (const [name, w, h] of [['portrait 390x844', 390, 844], ['LANDSCAPE 844x390', 844, 390], ['small landscape 740x360', 740, 360]]) {
  console.log(`\n=== ${name} ===`);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  // Deliberately more content than fits — this is what broke before.
  await page.setContent(html(page$(9)), { waitUntil: 'load' });

  const panel = await box('panel');
  const top = await box('topbar');
  const modes = await box('modes');

  check('panel never runs off the top of the screen', panel.top >= 0, `top=${panel.top}`);
  check('panel does not cover the top bar', panel.top >= top.bottom - 1,
    `panel.top=${panel.top} topbar.bottom=${top.bottom}`);
  check('panel scrolls its overflow instead of escaping',
    panel.scrollH > panel.clientH ? panel.overflowY === 'auto' : true,
    `scroll=${panel.scrollH} client=${panel.clientH} overflow=${panel.overflowY}`);
  // The reported symptom: the profile chips were pushed off-screen with no way back.
  check('route-profile chips are reachable', modes.top >= 0 && modes.height > 0,
    `modes.top=${modes.top}`);
  check('some map is still visible', panel.height < h, `panel=${panel.height} of ${h}`);
}

console.log('\n=== FOOTER AS BUTTONS ===');
await page.setViewport({ width: 390, height: 844 });
await page.setContent(html(nav), { waitUntil: 'load' });
const footer = await box('footer');
check('footer sits at the bottom', Math.round(footer.bottom) === 844, `${footer.bottom}`);
const tabs = await page.evaluate(() => [...document.querySelectorAll('#footer a')].map(a => {
  const cs = getComputedStyle(a);
  const r = a.getBoundingClientRect();
  return { bg: cs.backgroundColor, radius: cs.borderRadius, h: r.height, text: a.textContent.trim() };
}));
check('five tabs', tabs.length === 5);
check('each tab is a rounded button', tabs.every(t => parseFloat(t.radius) >= 8), tabs[0]?.radius);
check('each tab is a real tap target', tabs.every(t => t.h >= 36), `${tabs[0]?.h}`);
check('the selected tab is the filled one',
  tabs.filter(t => t.bg === 'rgb(249, 115, 22)').length === 1,
  JSON.stringify(tabs.map(t => t.bg)));
check('tabs are worded, not emoji', tabs.every(t => /^[A-Za-z]+$/.test(t.text)),
  JSON.stringify(tabs.map(t => t.text)));

console.log('\n=== FOOTER SHRINKS ON A SIDEWAYS PHONE ===');
await page.setViewport({ width: 844, height: 390 });
await page.setContent(html(nav), { waitUntil: 'load' });
const shortFooter = await box('footer');
check('footer is shorter in landscape', shortFooter.height <= 50, `${shortFooter.height}`);
check('it still clears a gloved thumb', shortFooter.height >= 40, `${shortFooter.height}`);

console.log('\n=== THEMES ===');
await page.setViewport({ width: 390, height: 844 });
for (const [label, theme, expectDark] of [['dark', 'dark', true], ['light', 'light', false]]) {
  await page.setContent(html(nav, theme), { waitUntil: 'load' });
  const f = await box('footer');
  const m = f.bg.match(/\d+/g).slice(0, 3).map(Number);
  const isDark = (m[0] + m[1] + m[2]) / 3 < 110;
  check(`${label} theme paints a ${expectDark ? 'dark' : 'light'} surface`, isDark === expectDark, f.bg);
}
// With no data-theme the page must follow the phone, not lock to dark.
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.setContent(html(nav), { waitUntil: 'load' });
const sys = await box('footer');
const c = sys.bg.match(/\d+/g).slice(0, 3).map(Number);
check('system setting follows a light phone', (c[0] + c[1] + c[2]) / 3 > 200, sys.bg);

await browser.close();
console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
