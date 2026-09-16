// The badge that marks another rider on the map.
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [, , SRC, CHROME] = process.argv;
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const out = join(mkdtempSync(join(tmpdir(), 'rh-')), 'badge.mjs');
await build({ entryPoints: [SRC], outfile: out, bundle: true, format: 'esm',
  platform: 'neutral', target: 'es2020', logLevel: 'silent' });
const B = await import(pathToFileURL(out).href);

console.log('\n=== THE LETTER ===');
check('takes the first letter', B.initialOf('Bilal') === 'B');
check('uppercases it', B.initialOf('arjun') === 'A');
check('ignores leading spaces', B.initialOf('   raj kumar') === 'R');
check('uses the first name, not the surname', B.initialOf('Deepa Nair') === 'D');
// An empty badge would be worse than a placeholder.
check('falls back when there is no name', B.initialOf('') === '•');
check('falls back on whitespace only', B.initialOf('   ') === '•');
check('handles a non-Latin name', B.initialOf('अर्जुन').length === 1, B.initialOf('अर्जुन'));

console.log('\n=== IT CANNOT BREAK THE SVG ===');
// The name comes from another user, so it is untrusted input in a markup document.
const nasty = B.riderBadgeSvg('<script>alert(1)</script>', '#3b82f6');
check('markup in a name is escaped', !nasty.includes('<script'), nasty.slice(0, 80));
check('an ampersand is escaped', B.riderBadgeSvg('&co', '#3b82f6').includes('&amp;'));
// A colour is interpolated straight into an attribute, so it must be validated.
check('a bogus colour is replaced, not injected',
  !B.riderBadgeSvg('X', '" onload="alert(1)').includes('onload'));
check('a valid hex colour is kept', B.riderBadgeSvg('X', '#22c55e').includes('#22c55e'));

console.log('\n=== IT RENDERS ===');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200, deviceScaleFactor: 2 });
await page.setContent(
  `<body style="margin:0;background:#0f1117">
     <div id="w" style="position:absolute;left:60px;top:60px;width:${B.BADGE_PX}px;height:${B.BADGE_PX}px">
       ${B.riderBadgeSvg('Bilal', '#3b82f6')}
     </div>
   </body>`, { waitUntil: 'load' });
await page.$eval('#w svg', (el, px) => {
  el.setAttribute('width', String(px)); el.setAttribute('height', String(px));
}, B.BADGE_PX);

const m = await page.evaluate(() => {
  const svg = document.querySelector('#w svg');
  const disc = svg.querySelector('circle').getBoundingClientRect();
  const text = svg.querySelector('text');
  const t = text.getBoundingClientRect();
  return {
    letter: text.textContent,
    fill: getComputedStyle(svg.querySelector('circle')).fill,
    dx: Math.abs((t.left + t.width / 2) - (disc.left + disc.width / 2)),
    dy: Math.abs((t.top + t.height / 2) - (disc.top + disc.height / 2)),
    inside: t.width <= disc.width && t.height <= disc.height,
    discW: disc.width,
  };
});
check('the letter is drawn', m.letter === 'B', m.letter);
check('the disc takes the rider colour', m.fill === 'rgb(59, 130, 246)', m.fill);
check('the letter is centred horizontally', m.dx <= 1.5, `off by ${m.dx.toFixed(1)}px`);
check('the letter is centred vertically', m.dy <= 2, `off by ${m.dy.toFixed(1)}px`);
check('the letter fits inside the disc', m.inside);
// It has to be readable at a glance without swamping the map.
check('the badge is a sensible size', m.discW >= 20 && m.discW <= 40, `${m.discW.toFixed(0)}px`);

console.log('\n=== IT IS NOT THE RIDER OWN AVATAR ===');
// The arrow means "me"; a lettered disc means "someone else". They must not converge.
const badge = B.riderBadgeSvg('B', '#3b82f6');
check('the badge carries no direction arrow', !badge.includes('rotate('), 'found a rotation');
check('it is a data URI when packaged', B.riderBadge('B', '#3b82f6').startsWith('data:image/svg+xml'));

await browser.close();
console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
