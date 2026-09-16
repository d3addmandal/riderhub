// The navigator avatar and the heading that drives it.
//
// The reported bug was the vehicle glyph sitting outside its disc. That happened because
// a Google Maps marker label is positioned independently of its symbol, so the two could
// drift apart. These checks render the real SVG and measure where the parts actually
// land, rather than trusting that one image "should" hold together.
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

const out = join(mkdtempSync(join(tmpdir(), 'rh-')), 'avatar.mjs');
await build({ entryPoints: [SRC], outfile: out, bundle: true, format: 'esm',
  platform: 'neutral', target: 'es2020', logLevel: 'silent' });
const A = await import(pathToFileURL(out).href);

console.log('\n=== THE IMAGE IS ONE PIECE ===');
for (const mode of ['general', 'bike', 'car']) {
  const svg = A.avatarSvg(mode, 0);
  check(`${mode}: is a single svg`, svg.startsWith('<svg') && svg.trim().endsWith('</svg>'));
  check(`${mode}: has no text or label node`, !/<text|<tspan/.test(svg));
  const uri = A.avatarDataUri(mode, 0);
  check(`${mode}: encodes to a usable data URI`, uri.startsWith('data:image/svg+xml'));
}

console.log('\n=== HEADING IS BAKED IN ===');
check('rotation follows the heading', A.avatarSvg('bike', 90).includes('rotate(90.0'),
  A.avatarSvg('bike', 90).match(/rotate\([^)]*\)/)?.[0]);
check('nav mode draws it unrotated', A.avatarSvg('bike', 0).includes('rotate(0.0'));
check('a different heading yields a different image',
  A.avatarDataUri('bike', 45) !== A.avatarDataUri('bike', 200));

console.log('\n=== REDRAW IS NOT CHURNED ===');
// The compass fires many times a second; regenerating for a fraction of a degree is waste.
check('sub-degree jitter quantises to the same value',
  A.quantiseHeading(90.4) === A.quantiseHeading(91.1),
  `${A.quantiseHeading(90.4)} vs ${A.quantiseHeading(91.1)}`);
check('a real turn does change it', A.quantiseHeading(90) !== A.quantiseHeading(100));
check('wraps past north cleanly', A.quantiseHeading(359.9) === 0, `${A.quantiseHeading(359.9)}`);
check('negative headings normalise', A.quantiseHeading(-90) === 270, `${A.quantiseHeading(-90)}`);

console.log('\n=== RENDERED: THE GLYPH SITS INSIDE THE DISC ===');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 300, height: 300, deviceScaleFactor: 2 });

for (const mode of ['general', 'bike', 'car']) {
  await page.setContent(
    `<body style="margin:0;background:#222">
       <div id="wrap" style="position:absolute;left:100px;top:100px;width:${A.AVATAR_PX}px;height:${A.AVATAR_PX}px">
         ${A.avatarSvg(mode, 0)}
       </div>
     </body>`, { waitUntil: 'load' });

  await page.$eval('#wrap svg', el => { el.setAttribute('width', '44'); el.setAttribute('height', '44'); });

  const m = await page.evaluate(() => {
    const svg = document.querySelector('#wrap svg');
    const disc = svg.querySelector('.disc');
    const glyph = svg.querySelector('.glyph');
    const db = disc.getBoundingClientRect();
    const gb = glyph.getBoundingClientRect();
    return {
      disc: { cx: db.left + db.width / 2, cy: db.top + db.height / 2, w: db.width },
      glyph: { cx: gb.left + gb.width / 2, cy: gb.top + gb.height / 2, w: gb.width, h: gb.height },
    };
  });

  // This is the actual bug being pinned: the mark must be centred on the disc, not below it.
  const dx = Math.abs(m.glyph.cx - m.disc.cx);
  const dy = Math.abs(m.glyph.cy - m.disc.cy);
  check(`${mode}: glyph is centred horizontally on the disc`, dx <= 2, `off by ${dx.toFixed(1)}px`);
  check(`${mode}: glyph is centred vertically on the disc`, dy <= 3, `off by ${dy.toFixed(1)}px`);
  check(`${mode}: glyph fits inside the disc`, m.glyph.w <= m.disc.w + 1,
    `glyph ${m.glyph.w.toFixed(1)} vs disc ${m.disc.w.toFixed(1)}`);
  check(`${mode}: glyph is actually drawn`, m.glyph.w > 4 && m.glyph.h > 4,
    `${m.glyph.w.toFixed(1)}x${m.glyph.h.toFixed(1)}`);
}

console.log('\n=== THE MARK TURNS WITH THE HEADING ===');
// At 180° the nose should end up below the centre; at 0° above it.
const noseAt = async deg => {
  await page.setContent(
    `<body style="margin:0"><div id="wrap" style="position:absolute;left:100px;top:100px">
       ${A.avatarSvg('general', deg)}</div></body>`, { waitUntil: 'load' });
  return page.evaluate(() => {
    const svg = document.querySelector('#wrap svg');
    const disc = svg.querySelector('.disc').getBoundingClientRect();
    const nose = svg.querySelector('.glyph').getBoundingClientRect();
    return (nose.top + nose.height / 2) - (disc.top + disc.height / 2);
  });
};
const up = await noseAt(0);
const down = await noseAt(180);
check('pointing north, the nose is above centre', up < 0, `${up.toFixed(1)}`);
check('pointing south, the nose is below centre', down > 0, `${down.toFixed(1)}`);
check('the two are mirror images', Math.abs(up + down) < 2, `${up.toFixed(1)} / ${down.toFixed(1)}`);

await browser.close();
console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
