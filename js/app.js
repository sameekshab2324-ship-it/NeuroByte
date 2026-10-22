import { evaluate, STATE, RADIUS_MIN_M, RADIUS_MAX_M } from './geofence.js';
import { PatientSimulator } from './simulator.js';
import { destination, haversineMeters, mapsLink } from './geo.js';
import { t, setLang, getLang, localeTag, applyTranslations } from './i18n.js';
import * as store from './storage.js';
import { unlockAudio, setAlarmMode, setAlarmVolume } from './alarm.js';

const TICK_S = 0.5;
const TRAIL_MIN_STEP_M = 3;
const TRAIL_MAX_POINTS = 500;
const DEMO_BREACH_FACTOR = 1.6;
const DEMO_INSIDE_FACTOR = 0.4;

// Placeholder coordinates for the three zone presets; replace with real locations.
const PRESETS = {
  home: { lat: 12.9716, lng: 77.5946 },
  daycare: { lat: 12.9352, lng: 77.6245 },
  park: { lat: 12.9893, lng: 77.5536 },
};

const STATE_UI = {
  [STATE.SAFE]: { cls: 'bg-green-600', title: 'statusSafe', msg: 'statusSafeMsg', pin: 'safe' },
  [STATE.BREACH]: { cls: 'bg-amber-500', title: 'statusBreach', msg: 'statusBreachMsg', pin: 'breach' },
  [STATE.SOS]: { cls: 'bg-red-600', title: 'statusSos', msg: 'statusSosMsg', pin: 'sos' },
};

const $ = (id) => document.getElementById(id);

const prefs = store.loadPrefs();
let radius = clamp(Number(prefs.radius), RADIUS_MIN_M, RADIUS_MAX_M);
let presetKey = PRESETS[prefs.preset] ? prefs.preset : 'home';
let center = { ...PRESETS[presetKey] };

const sim = new PatientSimulator(center);
const trail = [];
let lastEval = null;
let lastState = null;
let simRunning = false;
let demoTimers = [];
let demoActive = false;
let draggingPatient = false;
let patientPinKind = null;

// ---- Map -----------------------------------------------------------------

const map = L.map('map').setView([center.lat, center.lng], 17);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const zoneCircle = L.circle([center.lat, center.lng], {
  radius,
  color: '#16a34a',
  fillColor: '#16a34a',
  fillOpacity: 0.12,
  weight: 2,
}).addTo(map);
const centerMarker = L.circleMarker([center.lat, center.lng], {
  radius: 5, color: '#1e3a8a', fillColor: '#1e3a8a', fillOpacity: 1,
}).addTo(map);
const trailLine = L.polyline([], { color: '#2563eb', weight: 4, opacity: 0.8 }).addTo(map);
const patientMarker = L.marker([center.lat, center.lng], { icon: pinIcon('safe'), draggable: true }).addTo(map);
patientMarker.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -12], className: 'patient-label' });
refreshPatientLabel();

map.on('click', (e) => {
  unlockAudio();
  breakTrail();
  sim.setPosition({ lat: e.latlng.lat, lng: e.latlng.lng });
  tick();
});

patientMarker.on('dragstart', () => {
  draggingPatient = true;
  breakTrail();
});
patientMarker.on('drag', (e) => {
  const { lat, lng } = e.target.getLatLng();
  sim.setPosition({ lat, lng });
});
patientMarker.on('dragend', () => {
  draggingPatient = false;
  unlockAudio();
  tick();
});

// Built with textContent so a typed name cannot inject HTML.
function refreshPatientLabel() {
  const span = document.createElement('span');
  span.textContent = store.loadProfile().name || '';
  patientMarker.setTooltipContent(span);
}

function pinIcon(kind) {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// ---- Feed loop -----------------------------------------------------------

function tick() {
  sim.step(TICK_S, center, radius, simRunning && !demoActive);
  const position = sim.position;
  const ev = evaluate({ position, center, radiusM: radius, sos: sim.sos });
  lastEval = { ...ev, position };
  recordTrail(position);
  handleTransition(lastEval);
  if (ev.state === STATE.BREACH) setAlarmVolume(breachVolume(ev.distanceM, radius));
  render();
}

// Starts at 30% just past the boundary and reaches full volume at twice the radius.
function breachVolume(distanceM, radiusM) {
  const overRatio = (distanceM - radiusM) / radiusM;
  return Math.min(1, 0.3 + overRatio);
}

function handleTransition(ev) {
  if (ev.state === lastState) return;
  const prev = lastState;
  lastState = ev.state;

  let eventKey = 'eventSafe';
  if (ev.state === STATE.SOS) eventKey = 'eventSos';
  else if (prev === STATE.SOS) eventKey = 'eventSosCleared';
  else if (ev.state === STATE.BREACH) eventKey = 'eventBreach';
  if (prev !== null) logEvent(eventKey, ev);

  if (ev.state === STATE.SAFE) setAlarmMode(null);
  else if (ev.state === STATE.BREACH) setAlarmMode('breach');
  else if (ev.state === STATE.SOS) {
    setAlarmMode('sos');
    lockMapOnPatient();
    openModal('medicalModal');
  }
}

// A null entry marks a teleport (map click or preset) so the line is not drawn across the jump.
function breakTrail() {
  if (trail.length && trail[trail.length - 1] !== null) trail.push(null);
}

function renderTrail() {
  const segments = [[]];
  for (const p of trail) {
    if (p === null) {
      if (segments[segments.length - 1].length) segments.push([]);
    } else {
      segments[segments.length - 1].push([p.lat, p.lng]);
    }
  }
  trailLine.setLatLngs(segments.filter((s) => s.length));
  $('trailCount').textContent = trail.filter(Boolean).length;
}

function recordTrail(position) {
  const last = trail[trail.length - 1];
  if (last && haversineMeters(last, position) < TRAIL_MIN_STEP_M) return;
  trail.push({ lat: position.lat, lng: position.lng });
  if (trail.length > TRAIL_MAX_POINTS) trail.shift();
  renderTrail();
}

// ---- Rendering -----------------------------------------------------------

function render() {
  if (!lastEval) return;
  const { state, distanceM, position } = lastEval;
  const ui = STATE_UI[state];
  // Replacing the icon mid-drag would cancel the drag, so only swap it when the status colour changes.
  if (!draggingPatient) patientMarker.setLatLng([position.lat, position.lng]);
  if (ui.pin !== patientPinKind) {
    patientMarker.setIcon(pinIcon(ui.pin));
    patientPinKind = ui.pin;
  }
  const banner = $('statusBanner');
  banner.classList.remove('bg-green-600', 'bg-amber-500', 'bg-red-600');
  banner.classList.add(ui.cls);
  $('bannerTitle').textContent = t(ui.title);
  $('bannerMsg').textContent = t(ui.msg);

  const battery = Math.round(sim.battery);
  $('batteryText').textContent = `${battery}%`;
  const bar = $('batteryBar');
  bar.style.width = `${battery}%`;
  bar.classList.toggle('bg-green-500', battery > 30);
  bar.classList.toggle('bg-red-500', battery <= 30);

  $('coordsText').textContent = `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
  $('distanceText').textContent = `${Math.round(distanceM)} ${t('meters')}`;

  $('simToggleBtn').textContent = t(simRunning ? 'stopSim' : 'startSim');
  $('simStatus').textContent = t(simRunning ? 'simRunning' : 'simIdle');

  const sosBtn = $('sosBtn');
  sosBtn.textContent = t(sim.sos ? 'sosCancel' : 'sosBtn');
  sosBtn.classList.toggle('ring-4', sim.sos);
  sosBtn.classList.toggle('ring-red-300', sim.sos);

  $('waBtn').classList.toggle('alert-ready', state !== STATE.SAFE);
}

function renderLogs() {
  const body = $('logBody');
  body.replaceChildren();
  const logs = store.loadLogs();
  if (logs.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'py-3 text-center text-slate-400';
    cell.textContent = t('noLogs');
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  logs.slice().reverse().forEach((entry) => {
    const row = document.createElement('tr');
    row.className = 'border-b last:border-0';
    const time = new Date(entry.ts).toLocaleString(localeTag());
    const cells = [
      time,
      t(entry.event),
      t(STATE_UI[entry.state]?.title ?? 'statusSafe'),
      `${entry.distance} ${t('meters')}`,
      `${entry.lat.toFixed(5)}, ${entry.lng.toFixed(5)}`,
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.className = 'py-2 pr-3';
      td.textContent = text;
      row.appendChild(td);
    });
    const linkCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = mapsLink(entry);
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'text-blue-700 underline';
    link.textContent = t('mapLink');
    linkCell.appendChild(link);
    row.appendChild(linkCell);
    body.appendChild(row);
  });
}

function renderMedicalCard() {
  const p = store.loadProfile();
  const none = t('none');
  $('cardName').textContent = p.name || none;
  $('cardBlood').textContent = p.bloodGroup || none;
  $('cardHistory').textContent = p.history || none;
  $('cardDoctor').textContent = p.doctor || none;
  $('cardDoctorPhone').textContent = p.doctorPhone || none;
  $('cardContact').textContent = p.contactPhone || none;
  const meds = $('cardMeds');
  meds.replaceChildren();
  const lines = (p.medications || '').split('\n').map((l) => l.trim()).filter(Boolean);
  (lines.length ? lines : [none]).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    meds.appendChild(li);
  });
}

function refreshLanguage() {
  applyTranslations();
  $('langToggle').textContent = t('langToggle');
  renderLogs();
  renderMedicalCard();
  render();
}

// ---- Logging & actions ---------------------------------------------------

function logEvent(eventKey, ev) {
  const position = ev?.position ?? sim.position;
  store.appendLog({
    ts: new Date().toISOString(),
    event: eventKey,
    state: ev?.state ?? STATE.SAFE,
    lat: position.lat,
    lng: position.lng,
    distance: Math.round(ev?.distanceM ?? haversineMeters(position, center)),
  });
  renderLogs();
}

function setSos(on) {
  sim.sos = on;
  if (on) unlockAudio();
  tick();
}

function lockMapOnPatient() {
  map.setView([lastEval.position.lat, lastEval.position.lng], 18, { animate: true });
}

function sendWhatsAppAlert() {
  unlockAudio();
  const p = store.loadProfile();
  const digits = (p.contactPhone || '').replace(/\D/g, '');
  if (!digits) {
    openModal('profileModal');
    $('waStatus').textContent = t('noContact');
    return;
  }
  const ev = lastEval;
  const message = t('waTemplate', {
    name: p.name,
    state: t(STATE_UI[ev.state].title),
    time: new Date().toLocaleString(localeTag()),
    distance: Math.round(ev.distanceM),
    radius,
    lat: ev.position.lat.toFixed(6),
    lng: ev.position.lng.toFixed(6),
    link: mapsLink(ev.position),
  });
  window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
  $('waStatus').textContent = t('waSent');
  logEvent('eventWaSent', ev);
}

function toggleSimulation() {
  unlockAudio();
  simRunning = !simRunning;
  logEvent(simRunning ? 'eventSimStart' : 'eventSimStop', lastEval);
  render();
}

function applyPreset(key) {
  presetKey = key;
  center = { ...PRESETS[key] };
  zoneCircle.setLatLng([center.lat, center.lng]);
  centerMarker.setLatLng([center.lat, center.lng]);
  map.setView([center.lat, center.lng], 17);
  sim.setPosition(center);
  trail.length = 0;
  renderTrail();
  persistPrefs();
  tick();
}

function runDemo() {
  stopDemo();
  unlockAudio();
  demoActive = true;
  $('demoStatus').classList.remove('hidden');
  logEvent('eventDemoStart', lastEval);

  const at = (ms, fn) => demoTimers.push(setTimeout(fn, ms));
  at(0, () => sim.moveTo(destination(center, 45, radius * DEMO_INSIDE_FACTOR), 25));
  at(3000, () => sim.moveTo(destination(center, 45, radius * DEMO_BREACH_FACTOR), 120));
  at(6000, () => setSos(true));
  at(8000, () => sim.moveTo(destination(center, 200, radius * 0.3), 120));
  at(10000, () => {
    setSos(false);
    demoActive = false;
    $('demoStatus').classList.add('hidden');
    logEvent('eventDemoEnd', lastEval);
  });
}

function stopDemo() {
  if (!demoActive) return;
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  demoActive = false;
  $('demoStatus').classList.add('hidden');
}

function persistPrefs() {
  store.savePrefs({ lang: getLang(), radius, preset: presetKey });
}

// ---- Modals --------------------------------------------------------------

function openModal(id) {
  if (id === 'medicalModal') renderMedicalCard();
  if (id === 'profileModal') fillProfileForm();
  $(id).classList.remove('hidden');
  $(id).classList.add('flex');
}

function closeModal(id) {
  $(id).classList.add('hidden');
  $(id).classList.remove('flex');
}

function fillProfileForm() {
  const p = store.loadProfile();
  const form = $('profileForm');
  Object.keys(p).forEach((key) => {
    if (form.elements[key]) form.elements[key].value = p[key];
  });
}

// ---- Helpers -------------------------------------------------------------

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// ---- Wiring --------------------------------------------------------------

document.addEventListener('pointerdown', unlockAudio, { once: true });

$('langToggle').addEventListener('click', () => {
  setLang(getLang() === 'en' ? 'kn' : 'en');
  persistPrefs();
  refreshLanguage();
});

$('radiusSlider').value = radius;
$('radiusValue').textContent = radius;
$('radiusSlider').addEventListener('input', (e) => {
  radius = clamp(Number(e.target.value), RADIUS_MIN_M, RADIUS_MAX_M);
  $('radiusValue').textContent = radius;
  zoneCircle.setRadius(radius);
  persistPrefs();
  tick();
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

$('simToggleBtn').addEventListener('click', toggleSimulation);
$('demoBtn').addEventListener('click', runDemo);
$('sosBtn').addEventListener('click', () => {
  if (sim.sos) {
    setSos(false);
  } else {
    setSos(true);
    lockMapOnPatient();
    openModal('medicalModal');
  }
});
$('waBtn').addEventListener('click', sendWhatsAppAlert);

$('clearTrailBtn').addEventListener('click', () => {
  trail.length = 0;
  trailLine.setLatLngs([]);
  $('trailCount').textContent = 0;
});

$('clearLogBtn').addEventListener('click', () => {
  store.clearLogs();
  renderLogs();
});

$('medicalIdBtn').addEventListener('click', () => openModal('medicalModal'));
$('closeMedicalBtn').addEventListener('click', () => closeModal('medicalModal'));
$('editProfileBtn').addEventListener('click', () => openModal('profileModal'));
$('cancelProfileBtn').addEventListener('click', () => closeModal('profileModal'));

$('profileForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  store.saveProfile(data);
  closeModal('profileModal');
  renderMedicalCard();
  refreshPatientLabel();
  if ($('waStatus').textContent === t('noContact')) $('waStatus').textContent = '';
});

// QR code points judges' phones at this dashboard; requires an http(s) origin.
if (window.location.protocol.startsWith('http')) {
  new QRCode($('qrBox'), { text: window.location.href, width: 150, height: 150 });
} else {
  $('qrNote').classList.remove('hidden');
}

setLang(prefs.lang);
persistPrefs();
refreshLanguage();
$('trailCount').textContent = 0;
setInterval(tick, TICK_S * 1000);
tick();
