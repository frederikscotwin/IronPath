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

  // Performance Management Chart time constants (days). The self-calibration
  // can suggest better values fitted to your data; you approve them here.
  ctlDays: 42,   // fitness
  atlDays: 7,    // fatigue
  seedCtl: 0,
  seedAtl: 0,
  loadBasis: 'trimp',   // 'trimp' (HR strain), 'energy' (kcal), or 'combined'
  energyBlend: 0.5,     // combined basis: weight on energy (0=all TRIMP, 1=all energy)

  // Energy model (Keytel HR->kcal needs these). Age optional but improves it.
  age: null,
  defaultWeightKg: 75,  // used until you log a weight
  weightUnit: 'kg',

  // Suggestion thresholds.
  tsbDeepFatigue: -25,
  tsbVeryFresh: 15,
  rampWarn: 8,   // fitness points/week considered a fast (injury-risk) ramp

  // Which fields are user-set vs. estimated from history. When a field is
  // 'estimated', the app is free to keep refreshing it; 'manual' is locked.
  sources: { maxHr: 'manual', restHr: 'manual', lthr: 'estimated', cssSpeed: 'manual', runThresholdSpeed: 'manual' },
  lthr: null,          // lactate/functional threshold HR (estimated unless set)
  zoneModel: 'lthr',   // 'lthr' or 'maxhr'

  // Ironman finish-projection assumptions (all editable).
  imSwimFactor: 1.06,  // open-water sustained pace vs CSS (×slower)
  imBikeTargetKmh: 0,  // 0 = derive from your recent long rides
  imBikeIF: 0.70,
  imRunFactor: 1.10,   // marathon pace vs threshold pace (×slower)
  transitionsMin: 8,
  weightEconomyPct: 1.0, // % run improvement per % bodyweight drop
  raceBaselineWeight: 0, // 0 = use current smoothed weight

  // Auto-regulation / adaptive plan.
  acwrHigh: 1.5,          // acute:chronic ratio danger threshold
  acwrLow: 0.8,           // below this = detraining/undertrained
  monotonyHigh: 2.5,      // Foster monotony injury/illness advisory (add variety)
  adaptHorizonDays: 7,    // how far ahead the adaptation pass reshapes
  adaptCutPct: 0.6,       // how much a hard session is cut when overreaching
  autoAdaptApply: false,  // apply adaptations automatically vs. suggest-and-approve

  // Race-day fuelling (per hour, on the bike+run).
  fuelCarbsPerHr: 80,     // g/hr
  fuelFluidMlPerHr: 600,  // ml/hr
  fuelSodiumMgPerHr: 700, // mg/hr

  // Taper.
  taperWeeks: 3,
  taperTargetTsb: 20,

  // Threshold-test scheduler.
  testIntervalWeeks: 6,
  lastTestDate: '',

  // Goal.
  raceName: '',
  raceDate: '',  // ISO date; empty while base-building

  // Strava (optional). Token pasted in Settings or fetched via the OAuth helper.
  stravaAccessToken: '',
  stravaTokenExpiry: 0,

  // In-app AI coach. Provider-agnostic (OpenAI-compatible) OR on-device (WebLLM).
  aiEngine: 'cloud',          // 'cloud' | 'local'
  aiBaseUrl: '',              // e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://localhost:11434/v1
  aiModel: '',                // e.g. gpt-4o-mini, anthropic/claude-3.5-sonnet, llama3.1
  aiApiKey: '',               // stored locally; sent only to your chosen endpoint
  aiLocalModel: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', // WebLLM model id for on-device
  aiScopes: { journal: true, wellness: true, plan: true, thresholds: true, recovery: true }, // what the AI may edit (all via approval)
  aiSubjectiveWeight: 1.0,    // how strongly perceived fatigue nudges readiness (0 = ignore)

  version: 1,
};

const DB_NAME = 'ironpath';
const DB_VERSION = 4;

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
      if (!db.objectStoreNames.contains('weights')) {
        db.createObjectStore('weights', { keyPath: 'date' }); // { date:'YYYY-MM-DD', kg }
      }
      if (!db.objectStoreNames.contains('tests')) {
        db.createObjectStore('tests', { keyPath: 'id' }); // benchmark efforts
      }
      if (!db.objectStoreNames.contains('wellness')) {
        db.createObjectStore('wellness', { keyPath: 'date' }); // daily perceived fatigue/sleep/soreness
      }
      if (!db.objectStoreNames.contains('journal')) {
        db.createObjectStore('journal', { keyPath: 'id' }); // journal entries (user + AI)
      }
      if (!db.objectStoreNames.contains('modifiers')) {
        db.createObjectStore('modifiers', { keyPath: 'id' }); // illness/injury/stress/form-offset events
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

// ---- weights ----------------------------------------------------------------

export async function getAllWeights() {
  const db = await openDb();
  const rows = await done(tx(db, 'weights', 'readonly').getAll());
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
export async function putWeight(date, kg) {
  const db = await openDb();
  return done(tx(db, 'weights', 'readwrite').put({ date, kg }));
}
export async function deleteWeight(date) {
  const db = await openDb();
  return done(tx(db, 'weights', 'readwrite').delete(date));
}

// ---- benchmark tests --------------------------------------------------------

export async function getAllTests() {
  const db = await openDb();
  const rows = await done(tx(db, 'tests', 'readonly').getAll());
  return rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}
export async function putTest(test) {
  const db = await openDb();
  return done(tx(db, 'tests', 'readwrite').put(test));
}
export async function deleteTest(id) {
  const db = await openDb();
  return done(tx(db, 'tests', 'readwrite').delete(id));
}

// ---- daily wellness (perceived fatigue/sleep/soreness) ----------------------

export async function getAllWellness() {
  const db = await openDb();
  const rows = await done(tx(db, 'wellness', 'readonly').getAll());
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
export async function putWellness(entry) {
  const db = await openDb();
  return done(tx(db, 'wellness', 'readwrite').put(entry)); // { date, fatigue, sleep, soreness, stress, mood, note }
}
export async function deleteWellness(date) {
  const db = await openDb();
  return done(tx(db, 'wellness', 'readwrite').delete(date));
}

// ---- journal ----------------------------------------------------------------

export async function getAllJournal() {
  const db = await openDb();
  const rows = await done(tx(db, 'journal', 'readonly').getAll());
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
export async function putJournalEntry(entry) {
  const db = await openDb();
  return done(tx(db, 'journal', 'readwrite').put(entry)); // { id, date, text, tags, source:'user'|'ai' }
}
export async function deleteJournalEntry(id) {
  const db = await openDb();
  return done(tx(db, 'journal', 'readwrite').delete(id));
}

// ---- modifiers (illness / injury / stress / form offset) --------------------

export async function getAllModifiers() {
  const db = await openDb();
  const rows = await done(tx(db, 'modifiers', 'readonly').getAll());
  return rows.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}
export async function putModifier(m) {
  const db = await openDb();
  return done(tx(db, 'modifiers', 'readwrite').put(m)); // { id, date, type, severity, durationDays, note, source }
}
export async function deleteModifier(id) {
  const db = await openDb();
  return done(tx(db, 'modifiers', 'readwrite').delete(id));
}

// ---- full backup ------------------------------------------------------------

export async function exportBackup() {
  const [activities, settings, plan, weights, tests, wellness, journal, modifiers] = await Promise.all([
    getAllActivities(), getSettings(), getPlan(), getAllWeights(), getAllTests(), getAllWellness(), getAllJournal(), getAllModifiers()]);
  return { app: 'ironpath', version: 4, exportedAt: new Date().toISOString(), settings, plan, activities, weights, tests, wellness, journal, modifiers };
}

export async function importBackup(obj, mode = 'merge') {
  if (!obj || obj.app !== 'ironpath') throw new Error('Not an IronPath backup file.');
  if (mode === 'replace') {
    const db = await openDb();
    for (const s of ['activities', 'weights', 'tests', 'wellness', 'journal', 'modifiers']) await done(tx(db, s, 'readwrite').clear());
  }
  if (obj.settings) await saveSettings(obj.settings);
  if (obj.plan) await savePlan(obj.plan);
  if (obj.activities) await putActivities(obj.activities);
  for (const w of (obj.weights || [])) await putWeight(w.date, w.kg);
  for (const t of (obj.tests || [])) await putTest(t);
  for (const w of (obj.wellness || [])) await putWellness(w);
  for (const j of (obj.journal || [])) await putJournalEntry(j);
  for (const m of (obj.modifiers || [])) await putModifier(m);
  return { count: (obj.activities || []).length };
}
