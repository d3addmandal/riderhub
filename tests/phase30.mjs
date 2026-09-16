// SOS: what the server genuinely sends, and what it can only prepare.
//
// The distinction matters more here than anywhere else in the app. A browser cannot put
// a message through the SIM and WhatsApp has no send API, so those channels can only be
// opened pre-filled. These checks pin that the response says so plainly rather than
// implying an alert went out when it did not.
const API = 'http://localhost:3099';
const AUTH = 'http://localhost:9099/identitytoolkit.googleapis.com/v1';
let pass = 0, fail = 0; const fails = [];
const check = (n, c, d) => c ? (pass++, console.log(`  PASS  ${n}`))
  : (fail++, fails.push(n), console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`));

const signUp = async () => {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `sos${Date.now()}${Math.floor(performance.now())}@example.com`,
      password: 'password123', returnSecureToken: true }),
  });
  return (await r.json()).idToken;
};
const token = await signUp();

const call = async (m, p, body, tk = token) => {
  const res = await fetch(`${API}/api${p}`, {
    method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const PUNE = { lat: 18.5204, lng: 73.8567 };

console.log('\n=== TWO CONTACTS, EACH WITH ITS OWN WHATSAPP ===');
const saved = await call('PUT', '/users/profile', {
  name: 'Test Rider', phone: '+91 90000 00000', blood_group: 'B+',
  medical_notes: 'Allergic to penicillin',
  emergency_contacts: [
    { name: 'Asha', phone: '+91 98765 43210', whatsapp: '+91 91234 56789' },
    { name: 'Raj', phone: '+91 99999 11111' },
  ],
});
check('profile saves two contacts', saved.status === 200, JSON.stringify(saved.data).slice(0, 120));
check('both are stored', (saved.data.emergency_contacts ?? []).length === 2,
  `${saved.data?.emergency_contacts?.length}`);
check('a separate WhatsApp number survives',
  saved.data.emergency_contacts[0].whatsapp === '+91 91234 56789',
  saved.data?.emergency_contacts?.[0]?.whatsapp);
check('a contact with no WhatsApp is fine',
  saved.data.emergency_contacts[1].whatsapp === undefined);
check('a third contact is refused',
  (await call('PUT', '/users/profile', {
    name: 'X', emergency_contacts: [{ phone: '1' }, { phone: '2' }, { phone: '3' }],
  })).status === 400);

console.log('\n=== RAISING AN ALERT ===');
const sos = await call('POST', '/sos', { ...PUNE, message: 'Came off at the ghat' });
check('alert accepted', sos.status === 201, JSON.stringify(sos.data).slice(0, 120));
check('a maps link is produced', /maps\.google\.com/.test(sos.data.maps_link ?? ''), sos.data?.maps_link);

console.log('\n--- the message itself ---');
const t = sos.data.alert_text ?? '';
check('names the rider', t.includes('Test Rider'), t.slice(0, 60));
check('carries what the rider typed', t.includes('Came off at the ghat'));
check('carries the location link', t.includes(sos.data.maps_link));
// An ambulance asks for blood group before anything else.
check('carries the blood group', t.includes('B+'));
check('carries medical notes', t.includes('penicillin'));
check('carries the rider own number', t.includes('+91 90000 00000'));

console.log('\n--- what is automatic versus what needs a tap ---');
// No Telegram chat id is configured on this profile, so nothing can be truly automatic.
check('does not claim an automatic send it did not make', sos.data.auto_sent === false,
  `auto_sent=${sos.data?.auto_sent}`);
check('reports nothing in sent_to', (sos.data.sent_to ?? []).length === 0);
check('counts the channels still needing a tap', sos.data.needs_tap === 3,
  `needs_tap=${sos.data?.needs_tap}`);

const ch = sos.data.channels ?? [];
check('one SMS link per phone', ch.filter(c => c.kind === 'sms').length === 2);
check('one WhatsApp link, for the only contact that has one',
  ch.filter(c => c.kind === 'whatsapp').length === 1);
check('one call link per phone', ch.filter(c => c.kind === 'call').length === 2);

const sms = ch.find(c => c.kind === 'sms');
check('SMS link is an sms: URI to the number', sms.url.startsWith('sms:+919876543210?body='), sms?.url?.slice(0, 40));
check('SMS body is the alert, encoded', decodeURIComponent(sms.url.split('body=')[1]) === t);

const wa = ch.find(c => c.kind === 'whatsapp');
// wa.me wants bare digits; a leading plus breaks the link.
check('WhatsApp link uses digits only', wa.url.startsWith('https://wa.me/919123456789?text='), wa?.url?.slice(0, 40));
check('WhatsApp text is the alert', decodeURIComponent(wa.url.split('text=')[1]) === t);

const tel = ch.find(c => c.kind === 'call');
check('call link is a tel: URI', tel.url === 'tel:+919876543210', tel?.url);
check('channels are labelled with the contact name', ch.every(c => c.name === 'Asha' || c.name === 'Raj'),
  JSON.stringify(ch.map(c => c.name)));

console.log('\n=== FALLS BACK TO A LEGACY PROFILE ===');
const legacyToken = await signUp();
await call('PUT', '/users/profile',
  { name: 'Old Rider', emergency_contact_name: 'Mum', emergency_contact_phone: '+91 90000 12345' },
  legacyToken);
const legacy = await call('POST', '/sos', PUNE, legacyToken);
check('a profile with only the old fields still gets channels',
  (legacy.data.channels ?? []).length === 2, `${legacy.data?.channels?.length}`);
check('and they are addressed to that contact',
  legacy.data.channels.every(c => c.name === 'Mum'), JSON.stringify(legacy.data?.channels?.map(c => c.name)));

console.log('\n=== NO CONTACTS AT ALL ===');
const bareToken = await signUp();
await call('PUT', '/users/profile', { name: 'Lone Rider' }, bareToken);
const bare = await call('POST', '/sos', PUNE, bareToken);
// The event must still be recorded even with nobody to tell — it is the rider's own log.
check('the alert is still recorded', bare.status === 201, `${bare.status}`);
check('with no channels', (bare.data.channels ?? []).length === 0);
check('and says so honestly', bare.data.auto_sent === false && bare.data.needs_tap === 0);

console.log('\n=== HISTORY AND OWNERSHIP ===');
const hist = await call('GET', '/sos/history');
check('the alert is in the history', (hist.data ?? []).length >= 1, `${hist.data?.length}`);
check('another rider sees none of it', ((await call('GET', '/sos/history', null, bareToken)).data ?? []).length === 1);
check('SOS needs a signed-in rider', (await fetch(`${API}/api/sos`, { method: 'POST' })).status === 401);

console.log(`\n${'='.repeat(52)}\nPASSED: ${pass}   FAILED: ${fail}`);
if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
