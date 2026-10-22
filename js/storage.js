const KEYS = {
  logs: 'safestep.auditLog',
  profile: 'safestep.profile',
  prefs: 'safestep.prefs',
};
const MAX_LOGS = 500;

export const DEFAULT_PROFILE = {
  name: 'Ramesh Kumar',
  bloodGroup: 'B+',
  history: "Early-stage Alzheimer's disease; hypertension",
  doctor: 'Dr. Anitha Rao (Neurology)',
  doctorPhone: '+91 80 0000 0000',
  contactPhone: '+919900000000',
  medications: '08:00 - Donepezil 5 mg\n14:00 - Amlodipine 5 mg\n21:00 - Donepezil 5 mg',
};

const DEFAULT_PREFS = { lang: 'en', radius: 150, preset: 'home' };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('SafeStep: localStorage unavailable', err);
  }
}

export function loadLogs() {
  return read(KEYS.logs, []);
}

export function appendLog(entry) {
  const logs = loadLogs();
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  write(KEYS.logs, logs);
  return logs;
}

export function clearLogs() {
  localStorage.removeItem(KEYS.logs);
}

export function loadProfile() {
  return { ...DEFAULT_PROFILE, ...read(KEYS.profile, {}) };
}

export function saveProfile(profile) {
  write(KEYS.profile, profile);
}

export function loadPrefs() {
  return { ...DEFAULT_PREFS, ...read(KEYS.prefs, {}) };
}

export function savePrefs(prefs) {
  write(KEYS.prefs, prefs);
}
