// Renders the real chips in a real browser and measures what a rider would actually see.
// The reported bug was that clicking selected something but nothing looked selected, so
// asserting on computed styles — not on class names — is the only check that means
// anything here.
import puppeteer from 'puppeteer-core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2];
const CHROME = process.argv[3];
if (!DIST || !CHROME) { console.error('usage: node phase24.mjs <dist dir> <chrome path>'); process.exit(2); }

let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const cssFile = readdirSync(join(DIST, 'assets')).find(f => f.endsWith('.css'));
const css = readFileSync(join(DIST, 'assets', cssFile), 'utf8');

// The same markup Chip/ChipTile emit, so the styles under test are the shipped ones.
const chip = (sel, label) => `
  <button id="${sel ? 'on' : 'off'}" aria-pressed="${sel}"
    class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold
           whitespace-nowrap flex-shrink-0 border transition-all duration-150 active:scale-95
           disabled:opacity-40 disabled:pointer-events-none min-h-[36px]
           ${sel ? 'bg-accent border-accent text-accent-ink shadow-selected ring-2 ring-accent-ring'
                 : 'bg-surface2 border-border text-muted hover:text-white hover:bg-surface3 hover:border-accent/30'}">
    ${sel ? '<svg id="tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="flex-shrink-0 animate-pop"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
    <span>${label}</span>
  </button>`;

const tile = sel => `
  <button id="${sel ? 'tileOn' : 'tileOff'}" aria-pressed="${sel}"
    class="relative flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-xl
           border text-[11px] font-semibold transition-all duration-150 min-h-[58px]
           ${sel ? 'bg-accent border-accent text-accent-ink shadow-selected ring-2 ring-accent-ring'
                 : 'bg-surface2 border-border text-muted'}">
    ${sel ? `<span id="tileBadge" class="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full bg-white text-accent-press flex items-center justify-center shadow-raised animate-pop">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M20 6 9 17l-5-5"/></svg></span>` : ''}
    <span class="text-base leading-none">🛏️</span>
    <span class="leading-tight text-center">Night stop</span>
  </button>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body class="bg-bg" style="padding:20px">
  <div class="flex gap-2">${chip(false, 'Fuel')}${chip(true, 'Stay')}</div>
  <div class="grid grid-cols-3 gap-2" style="margin-top:16px">${tile(false)}${tile(true)}</div>
  <svg id="backIcon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted">
    <path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'load' });

const style = (id, props) => page.evaluate((id, props) => {
  const el = document.getElementById(id);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const out = { width: box.width, height: box.height };
  props.forEach(p => { out[p] = cs.getPropertyValue(p); });
  return out;
}, id, props);

const PROPS = ['background-color', 'border-color', 'color', 'box-shadow'];
const on = await style('on', PROPS);
const off = await style('off', PROPS);

console.log('\n=== THE SELECTED CHIP LOOKS SELECTED ===');
check('both chips rendered', !!on && !!off);
check('selected chip is filled orange',
  on['background-color'] === 'rgb(249, 115, 22)', on?.['background-color']);
check('unselected chip is not',
  off['background-color'] !== on['background-color'], off?.['background-color']);
check('selected border is the accent too',
  on['border-color'].startsWith('rgb(249, 115, 22'), on?.['border-color']);
check('selected and unselected text differ', on.color !== off.color, `${on?.color} vs ${off?.color}`);
check('selected carries a ring and a glow',
  on['box-shadow'].includes('rgba(249, 115, 22') || on['box-shadow'].includes('rgb(249, 115, 22'),
  on?.['box-shadow']?.slice(0, 90));
check('unselected has no glow', off['box-shadow'] === 'none', off?.['box-shadow']);

console.log('\n=== THE TICK — THE PART THAT SURVIVES COLOURBLINDNESS ===');
const tick = await style('tick', ['display', 'opacity', 'visibility']);
check('a tick is drawn inside the selected chip', !!tick, 'no #tick element');
check('the tick is actually visible',
  tick && tick.display !== 'none' && tick.visibility !== 'hidden' && tick.width > 0,
  JSON.stringify(tick));
check('no tick on the unselected chip',
  await page.evaluate(() => !document.querySelector('#off svg')));

const badge = await style('tileBadge', ['background-color', 'color']);
check('the tile shows a corner tick badge', !!badge && badge.width > 0, JSON.stringify(badge));
check('badge is white on accent, so it reads on the orange fill',
  badge['background-color'] === 'rgb(255, 255, 255)', badge?.['background-color']);
check('no badge on the unselected tile',
  await page.evaluate(() => !document.querySelector('#tileOff span.absolute')));

console.log('\n=== CONTRAST AND TAP TARGETS ===');
// Selected chips must survive sunlight: white on #f97316 is ~3.6:1, fine at this weight.
const contrast = (a, b) => {
  const lum = c => {
    const [r, g, b2] = c.match(/\d+/g).slice(0, 3).map(Number).map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const onContrast = contrast(on.color, on['background-color']);
const offContrast = contrast(off.color, off['background-color']);
// AA for normal-size text. White on this orange only reaches 2.8, which is why the
// selected state uses a dark ink instead.
check('selected label clears AA on the fill', onContrast >= 4.5, onContrast.toFixed(2));
check('unselected label clears AA too', offContrast >= 4.5, offContrast.toFixed(2));
check('the tick itself is legible on the fill', onContrast >= 4.5, onContrast.toFixed(2));
check('the two states are unmistakably different fills',
  contrast(on['background-color'], off['background-color']) >= 2.5,
  contrast(on['background-color'], off['background-color']).toFixed(2));

check('chips meet a gloved tap target', on.height >= 36 && off.height >= 36, `${on?.height}`);
const tileOn = await style('tileOn', PROPS);
check('tiles meet a gloved tap target', tileOn.height >= 56, `${tileOn?.height}`);

console.log('\n=== THE BACK ICON IS DRAWN, NOT TYPED ===');
const back = await style('backIcon', ['color']);
check('back icon renders at its asked-for size',
  back && back.width === 20 && back.height === 20, JSON.stringify(back));
check('it inherits currentColor rather than a hardcoded fill',
  back.color === 'rgb(154, 165, 189)', back?.color);
check('it is a real path, not a glyph',
  await page.evaluate(() => document.querySelectorAll('#backIcon path').length === 2));

await browser.close();

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
