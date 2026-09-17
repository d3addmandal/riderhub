// Correcting a service record.
//
// A service is transcribed off a workshop invoice, so it gets typed wrong: a digit in the
// odometer, a part left off, the wrong bike. Until now the app could only add and delete
// one, and deleting to re-enter loses the service number and the maintenance reset that
// came with it — so the edit path is the one riders will actually reach for.
//
// The subtle part is the money. The client never sends a total: it sends labour and the
// parts, and the server adds them up. An edit therefore has to recompute, and has to keep
// the figures it was not given rather than zeroing them.
const API = 'http://localhost:3099';
const AUTH = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

let seq = 0;
async function rider(name) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `s${Date.now()}${seq++}@example.com`, password: 'password123', returnSecureToken: true }),
  });
  const token = (await r.json()).idToken;
  const call = async (m, p, body) => {
    const res = await fetch(`${API}/api${p}`, {
      method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  await call('PUT', '/users/profile', { name });
  const bike = (await call('POST', '/bikes', {
    brand: 'Royal Enfield', model: name, year: 2023,
    registration_no: `MH14${seq}${Date.now() % 1000}`, current_odometer: 10000,
  })).data;
  return { name, token, call, bike };
}

const owner = await rider('Deepak');
const stranger = await rider('Esha');

console.log('\n=== A SERVICE IS LOGGED, AND ITS TOTAL IS THE SERVER\'S ARITHMETIC ===');
const created = (await owner.call('POST', '/services', {
  motorcycle_id: owner.bike.id,
  service_date: '2026-03-01',
  odometer: 12000,
  workshop: 'ABC Auto',
  service_type: 'Full Service',
  notes: 'Annual',
  labour_cost: 500,
  parts: [
    { part_name: 'Engine oil', brand: 'Motul', cost: 900, quantity: 1 },
    { part_name: 'Oil filter', cost: 200, quantity: 1 },
  ],
})).data;
check('the record is created', !!created?.id, JSON.stringify(created).slice(0, 120));
check('parts are stored', (created.service_parts ?? []).length === 2);
check('the total is labour plus parts', created.cost === 1600, `cost ${created.cost}`);

console.log('\n=== CORRECTING ONE FIGURE RECOMPUTES THE TOTAL ===');
// The classic fix: the labour line was mistyped. Everything else must survive it.
const relabour = (await owner.call('PUT', `/services/${created.id}`, { labour_cost: 800 })).data;
check('the new labour is stored', relabour.labour_cost === 800);
check('the total follows it', relabour.cost === 1900, `cost ${relabour.cost}`);
check('the parts are untouched', (relabour.service_parts ?? []).length === 2);
check('fields that were not sent are kept', relabour.workshop === 'ABC Auto' && relabour.notes === 'Annual');
check('the bike is still the same one', relabour.motorcycle_id === owner.bike.id);

console.log('\n=== ADDING A FORGOTTEN PART ===');
const withPart = (await owner.call('PUT', `/services/${created.id}`, {
  parts: [
    { part_name: 'Engine oil', brand: 'Motul', cost: 900, quantity: 1 },
    { part_name: 'Oil filter', cost: 200, quantity: 1 },
    { part_name: 'Brake pads', cost: 600, quantity: 2 },
  ],
})).data;
check('the part is added', (withPart.service_parts ?? []).length === 3);
check('parts_cost is recomputed', withPart.parts_cost === 1700, `parts_cost ${withPart.parts_cost}`);
check('the total includes it, keeping the corrected labour', withPart.cost === 2500, `cost ${withPart.cost}`);

console.log('\n=== REMOVING A PART DOES NOT LEAVE ITS COST BEHIND ===');
const fewer = (await owner.call('PUT', `/services/${created.id}`, {
  parts: [{ part_name: 'Engine oil', brand: 'Motul', cost: 900, quantity: 1 }],
})).data;
check('only the remaining part is stored', (fewer.service_parts ?? []).length === 1);
check('the total drops accordingly', fewer.cost === 1700, `cost ${fewer.cost}`);

console.log('\n=== A CORRECTED ODOMETER REACHES THE BIKE ===');
// Riders correct this one most often, and it is what every maintenance clock counts from.
await owner.call('PUT', `/services/${created.id}`, { odometer: 12500 });
const bike = (await owner.call('GET', `/bikes/${owner.bike.id}`)).data;
check('the bike odometer moves up with it', bike.current_odometer >= 12500, `odometer ${bike.current_odometer}`);

console.log('\n=== THE RECORD STAYS ITS OWNER\'S ===');
const intruder = await stranger.call('PUT', `/services/${created.id}`, { labour_cost: 1 });
check('another rider cannot edit it', intruder.status === 404, `status ${intruder.status}`);
const unchanged = (await owner.call('GET', `/services/${created.id}`)).data;
check('and nothing of theirs got through', unchanged.labour_cost === 800);
check('a record that does not exist is a 404',
  (await owner.call('PUT', '/services/no-such-record', { labour_cost: 1 })).status === 404);

console.log('\n=== NONSENSE IS REFUSED, NOT STORED ===');
check('a negative odometer is rejected',
  (await owner.call('PUT', `/services/${created.id}`, { odometer: -5 })).status === 400);
check('a part with no name is rejected',
  (await owner.call('PUT', `/services/${created.id}`, { parts: [{ part_name: '', cost: 10 }] })).status === 400);
const survived = (await owner.call('GET', `/services/${created.id}`)).data;
check('the record survived both attempts intact',
  survived.cost === 1700 && (survived.service_parts ?? []).length === 1, `cost ${survived.cost}`);

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
