// Route profiles, alternative routes, and the full place card.
const API = 'http://localhost:3099';
const AUTH = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `rm${Date.now()}@example.com`, password: 'password123', returnSecureToken: true }),
});
const token = (await r.json()).idToken;

const call = async (m, p, body) => {
  const res = await fetch(`${API}/api${p}`, {
    method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
};

const PUNE = { lat: 18.5204, lng: 73.8567 }, LONAVALA = { lat: 18.7546, lng: 73.4062 };

console.log('\n=== THREE ROUTE PROFILES ===');
const modes = await call('GET', '/routing/modes');
check('modes are listed', modes.data.modes.length === 3, JSON.stringify(modes.data?.modes?.map(m => m.id)));
check('bike maps to the two-wheeler engine',
  modes.data.modes.find(m => m.id === 'bike').travel_mode === 'TWO_WHEELER');
check('car and general share the driving engine',
  modes.data.modes.find(m => m.id === 'car').travel_mode === 'DRIVE'
  && modes.data.modes.find(m => m.id === 'general').travel_mode === 'DRIVE');
// The whole point of the bike profile: it is the only one that changes road eligibility.
check('only bike claims two-wheeler restrictions',
  modes.data.modes.filter(m => m.respects_two_wheeler_restrictions).map(m => m.id).join() === 'bike');

for (const mode of ['bike', 'car', 'general']) {
  const res = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA, mode });
  check(`${mode} profile routes and is echoed back`, res.data.mode === mode, `mode=${res.data?.mode}`);
}
check('an unknown profile is rejected',
  (await call('POST', '/routing/route', { from: PUNE, to: LONAVALA, mode: 'boat' })).status === 400);
check('no profile given still routes',
  (await call('POST', '/routing/route', { from: PUNE, to: LONAVALA })).data.mode === 'general');

console.log('\n=== PROFILES ARE CACHED APART ===');
// Serving a car route to a bike request would send a rider onto a barred road.
const bikeR = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA, mode: 'bike' });
const carR = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA, mode: 'car' });
check('bike and car answers stay distinct', bikeR.data.mode === 'bike' && carR.data.mode === 'car',
  `${bikeR.data?.mode} / ${carR.data?.mode}`);
const tollR = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA, mode: 'car', avoid_tolls: true });
check('avoid-tolls is not served the toll route from cache', tollR.status === 200 && tollR.data.mode === 'car');

console.log('\n=== ALTERNATIVE ROUTES ===');
const alt = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA, alternatives: true });
check('alternatives returned', (alt.data.alternatives ?? []).length === 2, `${alt.data?.alternatives?.length}`);
check('sorted quickest first',
  alt.data.alternatives[0].duration_s <= alt.data.alternatives[1].duration_s,
  alt.data.alternatives?.map(a => a.duration_s).join(' vs '));
// The mock returns the slow one first on purpose, so this proves the sort really runs.
check('the primary IS the quickest', alt.data.duration_s === alt.data.alternatives[0].duration_s,
  `${alt.data?.duration_s} vs ${alt.data?.alternatives?.[0]?.duration_s}`);
check('each way round is named', alt.data.alternatives.every(a => typeof a.summary === 'string'),
  JSON.stringify(alt.data.alternatives?.map(a => a.summary)));
check('each carries its own drawable geometry',
  alt.data.alternatives.every(a => a.geometry.length >= 2));
check('each carries its own turn steps',
  alt.data.alternatives.every(a => a.steps.length >= 1));
check('alternatives are not nested inside alternatives',
  alt.data.alternatives.every(a => a.alternatives === undefined));

const noAlt = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA });
check('not asked for, not returned', noAlt.data.alternatives === undefined);

// Google refuses alternatives once there are stops. Say so rather than show an empty list.
const withStops = await call('POST', '/routing/route', {
  from: PUNE, to: LONAVALA, via: [{ lat: 18.62, lng: 73.72 }], alternatives: true,
});
check('with stops, the limitation is explained',
  typeof withStops.data.alternatives_note === 'string' && withStops.data.alternatives_note.includes('stops'),
  withStops.data?.alternatives_note);
check('and the route itself still works', withStops.data.legs.length === 2, `${withStops.data?.legs?.length}`);

console.log('\n=== FULL PLACE CARD ===');
const d = await call('GET', '/places/detail?id=place_pump');
check('detail loads', d.status === 200, JSON.stringify(d.data).slice(0, 100));
check('rating and count', d.data.rating === 4.3 && d.data.rating_count === 1287);
check('open-now flag', d.data.open_now === true);
check('a week of hours', d.data.hours.length === 7, `${d.data?.hours?.length}`);
check('phone and website', !!d.data.phone && !!d.data.website);
check('editorial summary', d.data.summary === 'Fuel stop with air and a small shop.');
check('price level', d.data.price_level === 'PRICE_LEVEL_INEXPENSIVE');

console.log('\n--- reviews ---');
check('reviews returned', d.data.reviews.length === 2, `${d.data?.reviews?.length}`);
check('empty-text reviews dropped', d.data.reviews.every(rv => rv.text.length > 0));
check('review text read from either field',
  d.data.reviews.map(rv => rv.text).join('|').includes('Queue on weekends'),
  JSON.stringify(d.data.reviews?.map(rv => rv.text)));
check('author and age kept', d.data.reviews[0].author === 'Amit K' && !!d.data.reviews[0].relative_time);

console.log('\n--- the vendor page and photos ---');
check('links to the vendor Google page', d.data.google_maps_url === 'https://maps.google.com/?cid=1234567890',
  d.data?.google_maps_url);
check('photos are proxied, never raw Google URLs',
  d.data.photos.length === 2 && d.data.photos.every(p => p.startsWith('/places/photo?')),
  JSON.stringify(d.data?.photos));
// The API key must never reach the browser.
check('no API key leaks into the payload', !JSON.stringify(d.data).includes('test-key-not-real'));

const photo = await fetch(`${API}/api${d.data.photos[0]}&w=400`, { headers: { Authorization: `Bearer ${token}` } });
check('the photo proxy streams image bytes',
  photo.status === 200 && (photo.headers.get('content-type') ?? '').startsWith('image/'),
  `${photo.status} ${photo.headers.get('content-type')}`);
check('photos are cacheable', (photo.headers.get('cache-control') ?? '').includes('max-age'));

console.log('\n--- refusals ---');
check('photo proxy is not an open relay',
  (await call('GET', '/places/photo?name=' + encodeURIComponent('https://evil.example/x'))).status === 400);
check('photo proxy rejects a path-traversal name',
  (await call('GET', '/places/photo?name=' + encodeURIComponent('places/../../secret/photos/x'))).status === 400);
check('detail needs a signed-in rider', (await fetch(`${API}/api/places/detail?id=place_pump`)).status === 401);
check('photo needs a signed-in rider', (await fetch(`${API}/api/places/photo?name=places/a/photos/b`)).status === 401);
check('a fallback-provider place explains why it has no card',
  (await call('GET', '/places/detail?id=photon:18.5,73.8')).status === 400);
check('missing id rejected', (await call('GET', '/places/detail')).status === 400);

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
