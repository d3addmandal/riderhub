// The maintenance note: something the rider noticed, fixed at the next service.
//
// The value is entirely in the closing. Anyone can keep a list; the point is that when
// the bike finally reaches a workshop the list is still there, and afterwards each entry
// says which service dealt with it — so the bike's history records what was wrong, not
// only what was replaced.
const API = 'http://localhost:3099';
const AUTH = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

let seq = 0;
async function rider(name) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `i${Date.now()}${seq++}@example.com`, password: 'password123', returnSecureToken: true }),
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
    registration_no: `MH15${seq}${Date.now() % 1000}`, current_odometer: 20000,
  })).data;
  return { name, token, call, bike };
}

const owner = await rider('Farhan');
const stranger = await rider('Gita');

console.log('\n=== NOTING SOMETHING DOWN ===');
const noted = (await owner.call('POST', '/issues', {
  motorcycle_id: owner.bike.id,
  title: 'Chain noise at low revs',
  details: 'Rattles under 2500 rpm in third, quiet when the clutch is in.',
  severity: 'soon',
})).data;
check('the note is saved', !!noted?.id, JSON.stringify(noted).slice(0, 120));
check('it starts open', noted.status === 'open');
check('it remembers where the bike was when noticed',
  noted.noted_odometer === 20000, `odometer ${noted.noted_odometer}`);
check('it is stamped with a time so the workshop can see how long it has run', !!noted.noted_at);
check('severity defaults to "at the next service" when unstated',
  (await owner.call('POST', '/issues', { motorcycle_id: owner.bike.id, title: 'Mirror creeps' })).data.severity === 'soon');
check('a note needs a title', (await owner.call('POST', '/issues', { motorcycle_id: owner.bike.id, title: '' })).status === 400);
check('a note cannot be attached to a bike you do not own',
  (await stranger.call('POST', '/issues', { motorcycle_id: owner.bike.id, title: 'Not mine' })).status === 404);

console.log('\n=== THE LIST THE RIDER READS OUT AT THE COUNTER ===');
const urgent = (await owner.call('POST', '/issues', {
  motorcycle_id: owner.bike.id, title: 'Front brake lever comes to the bar', severity: 'urgent',
})).data;
const list = (await owner.call('GET', `/issues?motorcycle_id=${owner.bike.id}`)).data;
check('every open note is listed', list.length === 3, `${list.length} notes`);
check('the one that affects safety is first', list[0].id === urgent.id, list[0]?.title);
check('each note carries its bike', !!list[0].motorcycles?.brand);
check('another rider sees none of them',
  (await stranger.call('GET', '/issues')).data.length === 0);

console.log('\n=== THE SERVICE THAT FIXES THEM CLOSES THEM ===');
const service = (await owner.call('POST', '/services', {
  motorcycle_id: owner.bike.id,
  service_date: '2026-04-02',
  odometer: 20400,
  workshop: 'ABC Auto',
  labour_cost: 700,
  parts: [{ part_name: 'Chain and sprocket kit', cost: 3200, quantity: 1 }],
  resolved_issue_ids: [noted.id, urgent.id],
})).data;
check('the service is logged', !!service.id);
check('it reports which notes it closed', (service.issues_closed ?? []).length === 2,
  JSON.stringify(service.issues_closed));
check('the service remembers what it was asked to look at',
  (service.resolved_issue_ids ?? []).length === 2);

const after = (await owner.call('GET', `/issues?motorcycle_id=${owner.bike.id}`)).data;
const closed = after.find(i => i.id === noted.id);
check('the note is closed', closed.status === 'fixed');
check('and points at the service that dealt with it', closed.fixed_by_service_id === service.id);
check('with the date it was done', !!closed.fixed_at);
check('the note nobody mentioned is still open',
  after.find(i => i.title === 'Mirror creeps').status === 'open');
check('open notes sort above closed ones', after[0].status === 'open');
check('filtering to open ones works',
  (await owner.call('GET', `/issues?motorcycle_id=${owner.bike.id}&status=open`)).data.length === 1);

console.log('\n=== CLOSING BY HAND, AND WHEN IT COMES BACK ===');
const roadside = (await owner.call('POST', '/issues', {
  motorcycle_id: owner.bike.id, title: 'Loose number plate bolt', severity: 'watch',
})).data;
const fixed = (await owner.call('POST', `/issues/${roadside.id}/fix`, { fix_notes: 'Tightened at a dhaba.' })).data;
check('a note can be closed without a service', fixed.status === 'fixed' && fixed.fixed_by_service_id === null);
check('the note says how it was dealt with', fixed.fix_notes === 'Tightened at a dhaba.');

const back = (await owner.call('POST', `/issues/${noted.id}/reopen`)).data;
check('a note that comes back can be reopened', back.status === 'open');
check('and it no longer claims that service fixed it', back.fixed_by_service_id === null);

console.log('\n=== NOTES STAY THEIR OWNER\'S ===');
check('another rider cannot edit one', (await stranger.call('PUT', `/issues/${noted.id}`, { title: 'Hijacked' })).status === 404);
check('nor close one', (await stranger.call('POST', `/issues/${noted.id}/fix`, {})).status === 404);
check('nor delete one', (await stranger.call('DELETE', `/issues/${noted.id}`)).status === 404);
check('a note cannot be closed against someone else\'s service',
  (await owner.call('POST', `/issues/${roadside.id}/fix`, { service_id: 'not-a-service' })).status === 404);
check('the title survived every attempt',
  (await owner.call('GET', `/issues?motorcycle_id=${owner.bike.id}`)).data
    .find(i => i.id === noted.id).title === 'Chain noise at low revs');

console.log('\n=== CORRECTING AND REMOVING ===');
const edited = (await owner.call('PUT', `/issues/${noted.id}`, {
  title: 'Chain noise at low revs (worse in the wet)', severity: 'urgent',
})).data;
check('a note can be reworded', edited.title.endsWith('(worse in the wet)'));
check('and its severity raised', edited.severity === 'urgent');
check('a note can be deleted', (await owner.call('DELETE', `/issues/${roadside.id}`)).status === 204);
check('and is then gone', (await owner.call('DELETE', `/issues/${roadside.id}`)).status === 404);

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
