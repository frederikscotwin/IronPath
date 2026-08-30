// store.js — local-first persistence (IndexedDB) + your tunable settings.
// Everything lives on your device. Nothing is sent anywhere unless you explicitly
// use Strava sync or the AI export. The full JSON backup means you own it all.

export const DEFAULT_SETTINGS = {
  athleteName: 'Frederik',
  gender: 'male',              // affects the TRIMP weighting coefficient below

  // Heart-rate anchors (calibrate these — they drive every HR-based load).
  maxHr: 190,
  restHr: 50,

  // TRIMP exponential weighting: 1.92 (male) / 1.67 (female). Editable.
  trimpB: 1.92,

  // Fallback intensity when a session has no HR: estimate reserve from RPE (1-10).
  rpeToReserve: { base: 0.40, slope: 0.05 },   // reserve = base + slope*RPE
  // Last-resort reserve when there's neither HR nor RPE.
  defaultReserveBySport: { swim: 0.70, bike: 0.65, run: 0.72, strength: 0.50, other: 0.60 },

  // Thresholds for the secondary, sport-specific scores (m/s). Defaults are
  // placeholders — set from a real test (swim: a 400m TT; run: a 30-min TT).
  cssSpeed: 1.00,            // Critical Swim Speed ~ 1:40 /100m
  runThresholdSpeed: 3.70,  // ~ 4:30 /km

  // Performance Management Chart time constants (days).
  ctlDays: 42,   // fitness
  atlDays: 7,    // fatigue
  seedCtl: 0,
  seedAtl: 0,

  // Suggestion thresholds.
  tsbDeepFatigue: -25,
  tsbVeryFresh: 15,
  rampWarn: 8,   // fitness points/week considered a fast (injury-risk) ramp

  // Goal.
  raceName: '',
  raceDate: '',  // ISO date; empty while base-building

  // Strava (optional). Token pasted in Settings or fetched via the OAuth helper.
  stravaAccessToken: '',
  stravaTokenExpiry: 0,

  version: 1,
};

const DB_NAME = 'ironpath';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('activities')) {
        const s = db.createObjectStore('activities', { keyPath: 'id' });
        s.createIndex('startTime', 'startTime');
        s.createIndex('sport', 'sport');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) { return db.transaction(store, mode).objectStore(store); }
function done(request) {
  return new Promise((res, rej) => { request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error); });
}

export async function getAllActivities() {
  const db = await openDb();
  return done(tx(db, 'activities', 'readonly').getAll());
}

export async function putActivities(list) {
  const db = await openDb();
  const store = db.transaction('activities', 'readwrite').objectStore('activities');
  let added = 0, updated = 0;
  for (const a of list) {
    const existing = await done(store.get(a.id));
    if (existing) { updated++; store.put({ ...existing, ...a, id: a.id }); }
    else { added++; store.put(a); }
  }
  await new Promise((res) => { store.transaction.oncomplete = res; });
  return { added, updated };
}

export async function updateActivity(a) {
  const db = await openDb();
  return done(tx(db, 'activities', 'readwrite').put(a));
}

export async function deleteActivity(id) {
  const db = await openDb();
  return done(tx(db, 'activities', 'readwrite').delete(id));
}

export async function getMeta(key, fallback) {
  const db = await openDb();
  const row = await done(tx(db, 'meta', 'readonly').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDb();
  return done(tx(db, 'meta', 'readwrite').put({ key, value }));
}

export async function getSettings() {
  const saved = await getMeta('settings', null);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}
export async function saveSettings(s) { return setMeta('settings', s); }

export async function getPlan() {
  return getMeta('plan', { phases: [], sessions: [] });
}
export async function savePlan(p) { return setMeta('plan', p); }

// ---- full backup ------------------------------------------------------------

export async function exportBackup() {
  const [activities, settings, plan] = await Promise.all([getAllActivities(), getSettings(), getPlan()]);
  return { app: 'ironpath', version: 1, exportedAt: new Date().toISOString(), settings, plan, activities };
}

export async function importBackup(obj, mode = 'merge') {
  if (!obj || obj.app !== 'ironpath') throw new Error('Not an IronPath backup file.');
  if (mode === 'replace') {
    const db = await openDb();
    await done(tx(db, 'activities', 'readwrite').clear());
  }
  if (obj.settings) await saveSettings(obj.settings);
  if (obj.plan) await savePlan(obj.plan);
  if (obj.activities) await putActivities(obj.activities);
  return { count: (obj.activities || []).length };
}
