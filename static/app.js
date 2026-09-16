/* ── STATE ── */
const state = {
  socket: null,
  roomId: null,
  myName: null,
  myColor: null,
  mySid: null,
  riders: {},        // sid -> { name, color, lat, lng, marker, label }
  myMarker: null,
  destMarker: null,
  destMode: false,
  watchId: null,
  map: null,
};

/* ── DOM ── */
const $ = id => document.getElementById(id);
const screenLanding = $('screen-landing');
const screenMap = $('screen-map');

/* ── TOAST ── */
let toastTimer;
function toast(msg, dur = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

/* ── LANDING ── */
$('btn-create').addEventListener('click', async () => {
  const name = $('input-name').value.trim();
  if (!name) { showLandingError('Enter your rider name'); return; }

  try {
    const res = await fetch('/api/create_room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.error) { showLandingError(data.error); return; }
    connectAndJoin(name, data.room_id);
  } catch {
    showLandingError('Server error, try again');
  }
});

$('btn-join').addEventListener('click', async () => {
  const name = $('input-name').value.trim();
  const code = $('input-room').value.trim().toUpperCase();
  if (!name) { showLandingError('Enter your rider name'); return; }
  if (!code || code.length < 4) { showLandingError('Enter a valid room code'); return; }

  const res = await fetch(`/api/check_room/${code}`);
  const data = await res.json();
  if (!data.exists) { showLandingError('Room not found. Check the code.'); return; }
  connectAndJoin(name, code);
});

$('input-room').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

$('input-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create').click(); });
$('input-room').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });

function showLandingError(msg) {
  $('landing-error').textContent = msg;
  setTimeout(() => $('landing-error').textContent = '', 3500);
}

/* ── SOCKET ── */
function connectAndJoin(name, roomId) {
  state.myName = name;
  state.roomId = roomId;

  state.socket = io({ transports: ['websocket'] });

  state.socket.on('connect', () => {
    state.socket.emit('join', { name, room_id: roomId });
  });

  state.socket.on('joined', data => {
    state.myColor = data.color;
    state.mySid = state.socket.id;
    $('room-code-display').textContent = data.room_id;
    showMapScreen();
    initMap();

    // Add existing riders
    Object.entries(data.riders).forEach(([sid, r]) => {
      if (sid === state.socket.id) return;
      addRider(sid, r.name, r.color);
      if (r.lat != null) updateRiderMarker(sid, r.lat, r.lng);
    });

    if (data.destination) setDestMarker(data.destination);
    updateRidersList();
    startWatchingLocation();
  });

  state.socket.on('rider_joined', data => {
    addRider(data.sid, data.name, data.color);
    updateRidersList();
    toast(`${data.name} joined the group`);
  });

  state.socket.on('rider_left', data => {
    removeRider(data.sid);
    updateRidersList();
    toast(`${data.name} left the group`);
  });

  state.socket.on('location_update', data => {
    if (!state.riders[data.sid]) addRider(data.sid, data.name, data.color);
    updateRiderMarker(data.sid, data.lat, data.lng);
  });

  state.socket.on('destination_updated', dest => {
    if (dest) setDestMarker(dest);
    else clearDestMarker();
  });

  state.socket.on('error', data => showLandingError(data.message));
}

/* ── MAP ── */
function initMap() {
  state.map = L.map('map', { zoomControl: true, attributionControl: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(state.map);

  // Fallback center (world view)
  state.map.setView([20, 0], 3);

  state.map.on('click', e => {
    if (!state.destMode) return;
    setDestOnServer(e.latlng.lat, e.latlng.lng, 'Destination');
    exitDestMode();
  });
}

function makeDotIcon(color, size = 18) {
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeLabel(name, color) {
  return L.divIcon({
    className: 'rider-label',
    html: `<span style="color:${color}">${escHtml(name)}</span>`,
    iconAnchor: [-12, 8],
  });
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── MY LOCATION ── */
function startWatchingLocation() {
  if (!navigator.geolocation) { toast('Geolocation not supported'); return; }

  state.watchId = navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;

    // Update my marker
    if (!state.myMarker) {
      state.myMarker = L.marker([lat, lng], { icon: makeDotIcon(state.myColor, 22), zIndexOffset: 1000 })
        .addTo(state.map)
        .bindTooltip(state.myName + ' (you)', { permanent: false, direction: 'top' });
      state.map.setView([lat, lng], 15);
    } else {
      state.myMarker.setLatLng([lat, lng]);
    }

    // Emit to server
    state.socket.emit('location', { room_id: state.roomId, lat, lng });

    // Update my entry in riders for list
    if (!state.riders[state.mySid]) {
      state.riders[state.mySid] = { name: state.myName, color: state.myColor };
    }
    state.riders[state.mySid].lat = lat;
    state.riders[state.mySid].lng = lng;

  }, err => {
    if (err.code === 1) toast('Location permission denied');
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 });
}

/* ── RIDERS MAP MARKERS ── */
function addRider(sid, name, color) {
  if (!state.riders[sid]) {
    state.riders[sid] = { name, color, marker: null, labelMarker: null };
  }
}

function updateRiderMarker(sid, lat, lng) {
  const r = state.riders[sid];
  if (!r) return;
  r.lat = lat;
  r.lng = lng;

  if (!r.marker) {
    r.marker = L.marker([lat, lng], { icon: makeDotIcon(r.color) }).addTo(state.map);
    r.labelMarker = L.marker([lat, lng], { icon: makeLabel(r.name, r.color), interactive: false }).addTo(state.map);
    r.marker.bindTooltip(r.name, { permanent: false, direction: 'top' });
  } else {
    r.marker.setLatLng([lat, lng]);
    r.labelMarker.setLatLng([lat, lng]);
  }
}

function removeRider(sid) {
  const r = state.riders[sid];
  if (r) {
    if (r.marker) state.map.removeLayer(r.marker);
    if (r.labelMarker) state.map.removeLayer(r.labelMarker);
    delete state.riders[sid];
  }
}

/* ── DESTINATION ── */
function setDestMarker(dest) {
  if (state.destMarker) state.map.removeLayer(state.destMarker);
  const icon = L.divIcon({
    className: '',
    html: `<div style="font-size:28px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))">🏁</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
  state.destMarker = L.marker([dest.lat, dest.lng], { icon })
    .addTo(state.map)
    .bindTooltip(dest.name || 'Destination', { permanent: true, direction: 'top', className: 'rider-label' });
}

function clearDestMarker() {
  if (state.destMarker) { state.map.removeLayer(state.destMarker); state.destMarker = null; }
}

function setDestOnServer(lat, lng, name) {
  state.socket.emit('set_destination', { room_id: state.roomId, lat, lng, name });
}

/* ── DESTINATION MODE ── */
function enterDestMode() {
  state.destMode = true;
  $('dest-banner').classList.remove('hidden');
  state.map.getContainer().style.cursor = 'crosshair';
}

function exitDestMode() {
  state.destMode = false;
  $('dest-banner').classList.add('hidden');
  state.map.getContainer().style.cursor = '';
}

/* ── RIDERS PANEL ── */
function updateRidersList() {
  const list = $('riders-list');
  list.innerHTML = '';

  // My entry first
  const myEntry = { sid: state.mySid || 'me', name: state.myName, color: state.myColor, isMe: true };
  const allRiders = [myEntry, ...Object.entries(state.riders)
    .filter(([sid]) => sid !== state.mySid)
    .map(([sid, r]) => ({ sid, ...r, isMe: false }))
  ];

  allRiders.forEach(r => {
    const row = document.createElement('div');
    row.className = 'rider-row';
    row.innerHTML = `
      <div class="rider-dot" style="background:${r.color}"></div>
      <span class="rider-name">${escHtml(r.name)}</span>
      ${r.isMe ? '<span class="rider-you">you</span>' : ''}
    `;
    list.appendChild(row);
  });
}

/* ── UI CONTROLS ── */
function showMapScreen() {
  screenLanding.classList.remove('active');
  screenMap.classList.add('active');
}

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomId).then(() => toast('Room code copied!'));
});

$('btn-toggle-panel').addEventListener('click', () => {
  $('riders-panel').classList.toggle('hidden');
});

$('btn-close-panel').addEventListener('click', () => {
  $('riders-panel').classList.add('hidden');
});

$('btn-center-me').addEventListener('click', () => {
  if (state.myMarker) state.map.setView(state.myMarker.getLatLng(), 16);
  else toast('Waiting for your location...');
});

$('btn-center-all').addEventListener('click', () => {
  const points = [];
  if (state.myMarker) points.push(state.myMarker.getLatLng());
  Object.values(state.riders).forEach(r => { if (r.lat != null) points.push([r.lat, r.lng]); });
  if (points.length === 0) { toast('No rider locations yet'); return; }
  if (points.length === 1) { state.map.setView(points[0], 15); return; }
  state.map.fitBounds(L.latLngBounds(points).pad(0.2));
});

$('btn-set-dest').addEventListener('click', () => {
  if (state.destMode) exitDestMode();
  else enterDestMode();
});

$('btn-cancel-dest').addEventListener('click', exitDestMode);

$('btn-leave').addEventListener('click', () => {
  if (!confirm('Leave the group?')) return;
  if (state.watchId) navigator.geolocation.clearWatch(state.watchId);
  if (state.socket) state.socket.disconnect();
  location.reload();
});
