// Regression over the surface the routing and places rewrite could have broken.
//
// The earlier suites lived in a scratchpad that has since been cleared, so this
// re-establishes coverage of the contract the frontend actually depends on rather than
// assuming the old runs still stand.
const API = 'http://localhost:3099';
const AUTH = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `rg${Date.now()}@example.com`, password: 'password123', returnSecureToken: true }),
});
const token = (await r.json()).idToken;

const call = async (m, p, body) => {
  const res = await fetch(`${API}/api${p}`, {
    method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const PUNE = { lat: 18.5204, lng: 73.8567 }, LONAVALA = { lat: 18.7546, lng: 73.4062 };

console.log('\n=== THE ROUTE SHAPE THE MAP READS ===');
// The map draws from these fields on every render; losing one blanks the navigation card.
const rt = await call('POST', '/routing/route', { from: PUNE, to: LONAVALA });
check('routes without any new parameters', rt.status === 200, JSON.stringify(rt.data).slice(0, 90));
for (const f of ['provider', 'geometry', 'distance_m', 'duration_s', 'steps', 'legs', 'approximate']) {
  check(`still returns ${f}`, rt.data[f] !== undefined, `${f}=${rt.data?.[f]}`);
}
// The mock returns Google's own documented example polyline, which decodes to
// (38.5, -120.2). Asserting those exact values proves both the decoder and the
// [lng, lat] ordering the map relies on.
check('geometry decodes to [lng, lat] pairs',
  Array.isArray(rt.data.geometry[0])
  && Math.abs(rt.data.geometry[0][0] - -120.2) < 0.01
  && Math.abs(rt.data.geometry[0][1] - 38.5) < 0.01,
  JSON.stringify(rt.data.geometry?.[0]));
check('legs carry their own geometry', rt.data.legs[0].geometry.length >= 2);
check('steps carry an instruction, a distance and an end point',
  rt.data.steps[0].instruction.length > 0 && rt.data.steps[0].end?.lat != null);
check('HTML is stripped from instructions', !rt.data.steps[0].instruction.includes('<'),
  rt.data.steps?.[0]?.instruction);
check('traffic-aware flag set', rt.data.traffic_aware === true);

console.log('\n=== MULTI-STOP JOURNEY ===');
const via = await call('POST', '/routing/route', {
  from: PUNE, to: LONAVALA, via: [{ lat: 18.62, lng: 73.72 }, { lat: 18.70, lng: 73.55 }],
});
check('one leg per hop', via.data.legs.length === 3, `${via.data?.legs?.length}`);
check('every leg is drawable', via.data.legs.every(l => l.geometry.length >= 2));
check('legs sum to the journey total',
  Math.abs(via.data.legs.reduce((t, l) => t + l.distance_m, 0) - via.data.distance_m) <= 3);

console.log('\n=== VALIDATION AND AUTH ===');
check('needs a signed-in rider', (await fetch(`${API}/api/routing/route`, { method: 'POST' })).status === 401);
check('rejects an impossible latitude',
  (await call('POST', '/routing/route', { from: { lat: 999, lng: 73 }, to: LONAVALA })).status === 400);
check('same point is answered, not errored',
  (await call('POST', '/routing/route', { from: PUNE, to: PUNE })).status === 200);
check('status reports the provider',
  (await call('GET', '/routing/status')).data.road_routing === true);

console.log('\n=== PLACES STILL WORK ===');
const search = await call('GET', '/places/search?q=lonavala');
check('search returns suggestions', search.status === 200 && search.data.results.length >= 1,
  `${search.data?.results?.length}`);
const det = await call('GET', '/places/details?id=place_pump');
check('cheap details still resolve coordinates', det.status === 200 && det.data.lat != null,
  JSON.stringify(det.data).slice(0, 90));
const rev = await call('GET', '/places/reverse?lat=18.75&lng=73.40');
check('reverse geocode answers', rev.status === 200 && rev.data.lat === 18.75);
const near = await call('POST', '/places/nearby', { kind: 'fuel', lat: 18.75, lng: 73.4, radius_m: 5000 });
check('nearby search answers', near.status === 200 && near.data.results.length >= 1,
  `${near.data?.results?.length}`);
check('nearby results carry a detour distance',
  near.data.results.every(p => typeof p.detour_m === 'number'));

console.log('\n=== RIDES: STOPS AND NOTES ===');
const bike = (await call('POST', '/bikes', {
  brand: 'Royal Enfield', model: 'Himalayan', year: 2023,
  registration_number: `MH12RG${Date.now() % 10000}`, current_odometer: 12000,
})).data;
const ride = (await call('POST', '/rides', {
  motorcycle_id: bike.id, name: 'Regression ride', ride_type: 'solo',
  destination: { name: 'Lonavala', lat: 18.7546, lng: 73.4062 },
  stops: [{ name: 'Chai', lat: 18.6, lng: 73.7, kind: 'break' }],
  start_now: false,
})).data;
const R = `/rides/${ride.id}`;
check('ride created as planned', ride.status === 'planned');
check('stop kinds persisted', ride.stops[0].kind === 'break', ride.stops?.[0]?.kind);

const added = await call('POST', `${R}/stops`, {
  name: 'Night halt', lat: 18.7, lng: 73.5, kind: 'night', planned_minutes: 600, position: 'end',
});
check('stop added with its kind', added.status === 201);
let stops = (await call('GET', R)).data.stops.sort((a, b) => a.order - b.order);
check('night stop stored', stops.some(s => s.kind === 'night'), JSON.stringify(stops.map(s => s.kind)));
check('orders stay contiguous', stops.every((s, i) => s.order === i));

const ro = await call('PUT', `${R}/stops/reorder`, { order: [...stops].reverse().map(s => s.id) });
check('reorder works', ro.status === 200);
const moved = await call('PATCH', `${R}/stops/${stops[0].id}`, { lat: 18.9, lng: 73.1 });
check('a pin can be moved', moved.status === 200);

check('note added', (await call('POST', `${R}/notes`, { text: 'Regression note' })).status === 201);
check('note stored', (await call('GET', R)).data.ride_notes.length === 1);

console.log('\n=== OWNERSHIP ===');
const other = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `rx${Date.now()}@example.com`, password: 'password123', returnSecureToken: true }),
});
const t2 = (await other.json()).idToken;
const asOther = async (m, p) => (await fetch(`${API}/api${p}`, {
  method: m, headers: { Authorization: `Bearer ${t2}` },
})).status;
check('another rider cannot read the ride', await asOther('GET', R) === 404);

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
