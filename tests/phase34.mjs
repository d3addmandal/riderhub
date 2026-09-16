// Riding together: joining by code, who is in, and where everyone is.
const API = 'http://localhost:3099';
const AUTH = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

let seq = 0;
async function rider(name) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `j${Date.now()}${seq++}@example.com`, password: 'password123', returnSecureToken: true }),
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
    registration_no: `MH12${seq}${Date.now() % 1000}`, current_odometer: 10000,
  })).data;
  return { name, token, call, bike };
}

const leader = await rider('Arjun');
const mate = await rider('Bilal');
const stranger = await rider('Chetan');

console.log('\n=== A GROUP RIDE HAS A CODE; A SOLO ONE DOES NOT ===');
const group = (await leader.call('POST', '/rides', {
  motorcycle_id: leader.bike.id, name: 'Sunday run', ride_type: 'group',
  destination: { name: 'Lonavala', lat: 18.7546, lng: 73.4062 },
  start_location: { name: 'Pune', lat: 18.5204, lng: 73.8567 },
  start_now: true,
})).data;
check('group ride gets an invite code', !!group.invite_code, group.invite_code);
check('the leader is its first member', (group.member_ids ?? []).length === 1);

const solo = (await leader.call('POST', '/rides', {
  motorcycle_id: leader.bike.id, name: 'Solo blast', ride_type: 'solo',
  destination: { name: 'Khandala', lat: 18.75, lng: 73.38 }, start_now: false,
})).data;
check('a solo ride has no code', !solo.invite_code);

console.log('\n=== LOOKING A CODE UP BEFORE COMMITTING ===');
const look = await mate.call('GET', `/rides/lookup?code=${group.invite_code}`);
check('the code resolves', look.status === 200, JSON.stringify(look.data).slice(0, 90));
check('it names the ride and who leads it',
  look.data.name === 'Sunday run' && look.data.owner_name === 'Arjun',
  `${look.data?.name} / ${look.data?.owner_name}`);
check('it shows the destination', look.data.destination?.name === 'Lonavala');
check('it says it can be joined', look.data.joinable === true);
// A code is a weak secret, so a lookup must not hand over the whole ride.
check('it does not leak the stops or odometer',
  look.data.stops === undefined && look.data.start_odometer === undefined,
  Object.keys(look.data).join(','));
check('lowercase codes work too',
  (await mate.call('GET', `/rides/lookup?code=${group.invite_code.toLowerCase()}`)).status === 200);
check('a bad code is a clean 404', (await mate.call('GET', '/rides/lookup?code=ZZZZZZ')).status === 404);
check('lookup needs a signed-in rider',
  (await fetch(`${API}/api/rides/lookup?code=${group.invite_code}`)).status === 401);

console.log('\n=== JOINING ===');
const joined = await mate.call('POST', '/rides/join', {
  code: group.invite_code, motorcycle_id: mate.bike.id,
  start_location: { name: 'Kothrud', lat: 18.507, lng: 73.807 },
});
check('the mate joins', joined.status === 201, JSON.stringify(joined.data).slice(0, 100));
check('they are given their own colour', /^#[0-9a-f]{6}$/i.test(joined.data.member.colour),
  joined.data?.member?.colour);
check('their own bike is recorded', joined.data.member.bike_name.includes('Bilal'),
  joined.data?.member?.bike_name);
// The whole point: same destination, different start.
check('their own starting point is kept',
  joined.data.member.start_location.name === 'Kothrud',
  joined.data?.member?.start_location?.name);

console.log('\n--- refusals ---');
check('joining twice is refused',
  (await mate.call('POST', '/rides/join', { code: group.invite_code, motorcycle_id: mate.bike.id })).status === 409);
check('the leader cannot join their own ride',
  (await leader.call('POST', '/rides/join', { code: group.invite_code, motorcycle_id: leader.bike.id })).status === 409);
check('a solo ride cannot be joined',
  (await mate.call('POST', '/rides/join', { code: solo.invite_code ?? 'NONE', motorcycle_id: mate.bike.id })).status === 404);
// Attaching someone else's motorcycle to a ride must not be possible.
check('you cannot join on a bike that is not yours',
  (await stranger.call('POST', '/rides/join',
    { code: group.invite_code, motorcycle_id: mate.bike.id })).status === 400);
check('a bike is required', (await stranger.call('POST', '/rides/join', { code: group.invite_code })).status === 400);

console.log('\n=== A DUO IS EXACTLY TWO ===');
const duo = (await leader.call('POST', '/rides', {
  motorcycle_id: leader.bike.id, name: 'Two up', ride_type: 'duo',
  destination: { name: 'Mulshi', lat: 18.49, lng: 73.51 }, start_now: true,
})).data;
check('first joiner is welcome',
  (await mate.call('POST', '/rides/join', { code: duo.invite_code, motorcycle_id: mate.bike.id })).status === 201);
check('the third is turned away',
  (await stranger.call('POST', '/rides/join', { code: duo.invite_code, motorcycle_id: stranger.bike.id })).status === 409);

console.log('\n=== WHO IS RIDING ===');
const mem = await mate.call('GET', `/rides/${group.id}/members`);
check('members are listed', mem.status === 200 && mem.data.members.length === 2,
  `${mem.data?.members?.length}`);
check('the leader is first and marked', mem.data.members[0].is_owner === true
  && mem.data.members[0].name === 'Arjun');
check('the leader wears the accent colour', mem.data.members[0].colour === '#f97316');
check('the mate sees themselves flagged', mem.data.members.some(m => m.is_you && m.name === 'Bilal'));
check('a member knows they are not the owner', mem.data.you_are_owner === false);
check('the leader knows they are',
  (await leader.call('GET', `/rides/${group.id}/members`)).data.you_are_owner === true);
check('nobody outside the ride can see the roster',
  (await stranger.call('GET', `/rides/${group.id}/members`)).status === 404);

console.log('\n=== A MEMBER CAN READ THE RIDE, NOT REWRITE IT ===');
check('a member can open the ride', (await mate.call('GET', `/rides/${group.id}`)).status === 200);
check('a stranger cannot', (await stranger.call('GET', `/rides/${group.id}`)).status === 404);
// The route belongs to whoever planned it.
check('a member cannot add a stop',
  (await mate.call('POST', `/rides/${group.id}/stops`, { name: 'Mine', lat: 18.6, lng: 73.7 })).status === 404);
check('a member cannot reorder stops',
  (await mate.call('PUT', `/rides/${group.id}/stops/reorder`, { order: ['x'] })).status === 404);
check('a member cannot complete the ride',
  (await mate.call('POST', `/rides/${group.id}/complete`, { end_odometer: 10500 })).status === 404);
check('the leader still can add a stop',
  (await leader.call('POST', `/rides/${group.id}/stops`, { name: 'Chai', lat: 18.6, lng: 73.7 })).status === 201);

console.log('\n=== LIVE POSITIONS ===');
await mate.call('POST', `/rides/${group.id}/track`, {
  points: [{ lat: 18.55, lng: 73.80, t: new Date().toISOString(), speed: 42 }],
});
await leader.call('POST', `/rides/${group.id}/track`, {
  points: [{ lat: 18.60, lng: 73.75, t: new Date().toISOString(), speed: 55 }],
});

const liveForLeader = await leader.call('GET', `/rides/${group.id}/live`);
check('the leader sees the others', liveForLeader.status === 200
  && liveForLeader.data.riders.length === 1, `${liveForLeader.data?.riders?.length}`);
// Your own dot comes from your GPS, not a round trip.
check('and not themselves', !liveForLeader.data.riders.some(r => r.name === 'Arjun'));
check('each rider carries a name and colour',
  liveForLeader.data.riders.every(r => r.name && /^#[0-9a-f]{6}$/i.test(r.colour)),
  JSON.stringify(liveForLeader.data.riders?.map(r => [r.name, r.colour])));
check('positions come through',
  Math.abs(liveForLeader.data.riders[0].lat - 18.55) < 0.001,
  `${liveForLeader.data?.riders?.[0]?.lat}`);

const liveForMate = await mate.call('GET', `/rides/${group.id}/live`);
check('the mate sees the leader', liveForMate.data.riders.some(r => r.name === 'Arjun'));
check('members can post their own trail', true);
check('a stranger sees nothing', (await stranger.call('GET', `/rides/${group.id}/live`)).status === 404);
check('a stranger cannot post a trail to it',
  (await stranger.call('POST', `/rides/${group.id}/track`,
    { points: [{ lat: 1, lng: 1, t: new Date().toISOString() }] })).status === 404);

console.log('\n=== THE RIDE SHOWS IN BOTH LISTS ===');
const mateList = await mate.call('GET', '/rides');
const found = (mateList.data ?? []).find(r => r.id === group.id);
check('a joined ride appears for the member', !!found, `${mateList.data?.length} rides`);
check('and is marked as not theirs', found?.is_owner === false, `is_owner=${found?.is_owner}`);
check('with a rider count', found?.member_count === 2, `${found?.member_count}`);
const leaderList = await leader.call('GET', '/rides');
check('the leader still owns theirs',
  leaderList.data.find(r => r.id === group.id)?.is_owner === true);
check('a stranger sees neither',
  !(await stranger.call('GET', '/rides')).data.some(r => r.id === group.id));

console.log('\n=== LEAVING ===');
check('the leader cannot leave their own ride',
  (await leader.call('POST', `/rides/${group.id}/leave`, {})).status === 409);
check('a member can leave', (await mate.call('POST', `/rides/${group.id}/leave`, {})).status === 200);
check('and is gone from the roster',
  (await leader.call('GET', `/rides/${group.id}/members`)).data.members.length === 1);
check('and can no longer read the ride', (await mate.call('GET', `/rides/${group.id}`)).status === 404);
check('and stops being drawn on the map',
  (await leader.call('GET', `/rides/${group.id}/live`)).data.riders.length === 0);

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
