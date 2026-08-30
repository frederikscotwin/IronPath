// app.js — IronPath UI controller. Ties the store, model, parsers, charts and
// exports together into the tabbed PWA.

import * as store from './store.js';
import * as M from './model.js';
import * as E from './estimate.js';
import * as charts from './charts.js';
import { parseFile } from './parsers.js';
import { fetchStravaActivities } from './strava.js';
import * as PL from './plan.js';
import * as A from './adapt.js';
import { racePlan } from './race.js';
import { buildWorkoutFit, generateWorkoutFromSession, workoutToText } from './fitworkout.js';
import { fetchStravaStreams, fetchStravaDetail } from './strava.js';
import { buildAiPayload, buildPrompt } from './aiexport.js';
import * as AI from './aicoach.js';
import * as WL from './webllm.js';

const SPORTS = ['swim', 'bike', 'run', 'strength', 'other'];
const SPORT_COLORS = {
  swim: getVar('--swim'), bike: getVar('--bike'), run: getVar('--run'),
  strength: getVar('--strength'), other: getVar('--other'),
};
function getVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }

const state = { settings: null, activities: [], plan: null, weights: [], tests: [], wellness: [], journal: [], chat: [], pmc: [], est: null, tab: 'home' };

function todayWellness() { const k = M.dayKey(new Date()); return state.wellness.find(w => w.date === k) || null; }

// ---- boot -------------------------------------------------------------------

init();
async function init() {
  try {
    [state.settings, state.activities, state.plan, state.weights, state.tests, state.wellness, state.journal] = await Promise.all([
      store.getSettings(), store.getAllActivities(), store.getPlan(), store.getAllWeights(), store.getAllTests(), store.getAllWellness(), store.getAllJournal(),
    ]);
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="card"><h3>Storage error</h3><p>${e.message}</p><p class="muted">IronPath needs IndexedDB. If you're in private browsing, try a normal window.</p></div>`;
    return;
  }
  recompute();
  wireChrome();
  render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Ask the browser to keep our data (reduces the chance iOS evicts it).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then(p => { if (!p) navigator.storage.persist().catch(() => {}); }).catch(() => {});
  }
}

function recompute() {
  const plannedDaily = M.plannedDailyLoads(state.plan, state.settings);
  const hasFuture = [...plannedDaily.keys()].some(d => d > M.dayKey(new Date()));
  state.pmc = M.performanceChart(state.activities, state.settings, {
    plannedDaily,
    weights: state.weights,
    end: hasFuture ? [...plannedDaily.keys()].sort().slice(-1)[0] : M.dayKey(new Date()),
  });
  state.est = E.estimateThresholds(state.activities, state.tests, state.settings);
}

function wireChrome() {
  document.getElementById('tabbar').addEventListener('click', async e => {
    const b = e.target.closest('.tab'); if (!b) return;
    state.tab = b.dataset.tab;
    if (state.tab === 'plan') await applyPendingAdapt();
    render();
  });
  document.getElementById('gearBtn').addEventListener('click', () => { state.tab = 'setup'; render(); });
  document.getElementById('fileInput').addEventListener('change', onFilesChosen);
  document.getElementById('backupInput').addEventListener('change', onBackupChosen);
}

// ---- render dispatch --------------------------------------------------------

function render() {
  document.querySelectorAll('.tab').forEach(t =>
    t.setAttribute('aria-current', t.dataset.tab === state.tab ? 'true' : 'false'));
  const goal = state.settings.raceName || 'Ironman';
  const gh = document.getElementById('headerGoal');
  const cd = countdown();
  gh.innerHTML = cd ? `<b>${goal}</b> · ${cd}` : `<b>${goal}</b> · base building`;
  document.getElementById('gearBtn')?.classList.toggle('active', state.tab === 'setup');
  const view = document.getElementById('view');
  const map = { home: renderHome, log: renderLog, plan: renderPlan, coach: renderCoach, stats: renderStats, ai: renderAi, setup: renderSetup };
  view.innerHTML = (map[state.tab] || renderHome)();
  view.scrollTop = 0; window.scrollTo(0, 0);
  bindView();
  if (state.tab === 'setup') updateStorageStatus();
}

async function updateStorageStatus() {
  const el = document.getElementById('storageStatus'); if (!el) return;
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const usedMb = est && est.usage ? (est.usage / 1048576).toFixed(1) : null;
    const base = persisted === true ? 'Persistent storage granted — iOS won\'t auto-evict your data.'
      : persisted === false ? 'Saved locally (not marked persistent). Keep the app on your Home Screen and export a backup now and then.'
      : 'Data is saved locally in this browser.';
    el.textContent = base + (usedMb ? ` Using ${usedMb} MB.` : '');
  } catch { el.textContent = ''; }
}

function countdown() {
  if (!state.settings.raceDate) return null;
  const days = Math.ceil((new Date(state.settings.raceDate) - new Date()) / 86400000);
  if (days < 0) return 'race passed';
  const w = Math.floor(days / 7);
  return `${days} days${w ? ` (${w} wk)` : ''} to go`;
}

// ---- HOME -------------------------------------------------------------------

function renderHome() {
  const today = state.pmc.filter(p => !p.isFuture).slice(-1)[0];
  const sug = M.suggestions(state.pmc, state.settings, state.plan);
  const signals = A.fatigueSignals(state.pmc);
  const readiness = A.dailyReadiness(signals, M.weightTrend(state.weights), state.settings, todayWellness());
  const readyChip = signals ? `<div class="card ready-${readiness.color}"><div class="spread">
    <div style="display:flex;gap:11px;align-items:center"><span class="ready-dot ${readiness.color}"></span>
      <div><div style="font-weight:700">Readiness ${readiness.score}<span class="muted" style="font-weight:400"> / 100</span></div>
      <div class="muted" style="font-size:12.5px">${readiness.reasons[0]}${signals.acwr ? ` · ACWR ${signals.acwr.toFixed(2)}` : ''}${signals.monotony >= (state.settings.monotonyHigh ?? 2.5) ? ' · monotony high' : ''}</div></div></div>
    <button class="btn sm ghost" data-action="goto" data-tab="coach">Coach →</button></div></div>` : '';
  const tiles = today ? `
    <div class="tiles">
      <div class="tile fitness"><div class="k">Fitness</div><div class="v">${today.ctl.toFixed(0)}</div><div class="u">CTL · ${state.settings.ctlDays}d</div></div>
      <div class="tile fatigue"><div class="k">Fatigue</div><div class="v">${today.atl.toFixed(0)}</div><div class="u">ATL · ${state.settings.atlDays}d</div></div>
      <div class="tile form"><div class="k">Form</div><div class="v ${today.tsb < 0 ? 'neg' : ''}">${today.tsb > 0 ? '+' : ''}${today.tsb.toFixed(0)}</div><div class="u">TSB</div></div>
    </div>` : '';

  const chart = `<div class="card">
    <h3>Fitness · Fatigue · Form</h3>
    ${charts.pmcChart(state.pmc)}
    <div class="legend">
      <span><i style="background:var(--ctl)"></i>Fitness (CTL)</span>
      <span><i style="background:var(--atl)"></i>Fatigue (ATL)</span>
      <span><i style="background:var(--tsb)"></i>Form (TSB, right axis)</span>
    </div>
  </div>`;

  const sugCards = `<div class="card"><h3>What the model is telling you</h3>${
    sug.map(s => `<div class="sug ${s.level}"><div class="ic"></div><div><div class="title">${s.title}</div><div class="detail">${s.detail}</div></div></div>`).join('')
  }</div>`;

  const recent = [...state.activities].sort((a, b) => b.startTime.localeCompare(a.startTime)).slice(0, 4);
  const recentCard = recent.length ? `<div class="card"><h3>Recent sessions</h3>${recent.map(sessRow).join('')}</div>` : '';

  const quick = `<div class="card"><h3>Quick add</h3>
    <div class="card-actions">
      <button class="btn primary" data-action="import">Import file</button>
      <button class="btn" data-action="add">Add session</button>
      <button class="btn ghost" data-action="goto" data-tab="log">Log weight</button>
      <button class="btn ghost" data-action="goto" data-tab="coach">Coach</button>
    </div>
    <p class="field-note">Import a .fit, .tcx or .gpx from Garmin or Strava, or log a session by hand. Everything stays on your device.</p>
  </div>`;

  return `<h2 class="page-title">Dashboard</h2>
    ${tiles}
    ${readyChip}
    <div class="dash-2"><div>${chart}</div><div>${sugCards}${recentCard}</div></div>
    ${quick}`;
}

function sessRow(a) {
  const { load } = M.activityLoad(a, state.settings);
  return `<div class="sess" data-id="${a.id}" data-action="openSess">
    <span class="dot" style="background:${SPORT_COLORS[a.sport]}"></span>
    <div class="meta"><div class="t">${a.name || cap(a.sport)} <span class="pill">${a.sport}</span></div>
      <div class="d">${fmtDate(a.startTime)} · ${fmtDur(a.durationSec)}${a.distanceM ? ' · ' + fmtDist(a) : ''}${a.avgHr ? ' · ' + a.avgHr + ' bpm' : ''}${paceStr(a) ? ' · ' + paceStr(a) : ''}${a.rpe ? ' · RPE ' + a.rpe : ''}</div></div>
    <div class="load"><b>${Math.round(load)}</b>load</div>
  </div>`;
}

// ---- LOG --------------------------------------------------------------------

function renderLog() {
  const acts = [...state.activities].sort((a, b) => b.startTime.localeCompare(a.startTime));
  const groups = new Map();
  for (const a of acts) {
    const k = a.startTime.slice(0, 7); // YYYY-MM
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const list = acts.length ? [...groups.entries()].map(([mo, arr]) => {
    const load = arr.reduce((s, a) => s + M.activityLoad(a, state.settings).load, 0);
    const hrs = arr.reduce((s, a) => s + (a.durationSec || 0), 0) / 3600;
    return `<div class="card"><div class="spread" style="margin-bottom:6px"><h3 style="margin:0">${monthLabel(mo)}</h3>
      <span class="muted big-num">${hrs.toFixed(1)} h · ${Math.round(load)} load</span></div>
      ${arr.map(sessRow).join('')}</div>`;
  }).join('') : `<div class="card chart-empty">No sessions yet. Import a file or add one manually.</div>`;

  return `<h2 class="page-title">Training log</h2>
    <div class="card"><div class="card-actions">
      <button class="btn primary" data-action="import">Import .fit / .tcx / .gpx</button>
      <button class="btn" data-action="add">Add session</button>
      <button class="btn ghost" data-action="strava">Sync Strava</button>
      <button class="btn ghost" data-action="stravaStreams">Enrich from Strava</button>
    </div><p class="field-note">FIT and TCX carry full summaries and streams (best efforts, decoupling). GPX has no sport tag — set it after import. "Enrich from Strava" pulls each synced activity's perceived effort, description, notes and detailed streams.</p></div>
    ${weightSection()}
    ${wellnessSection()}
    ${testSection()}
    ${list}`;
}

function wellnessSection() {
  const today = M.dayKey(new Date());
  const cur = state.wellness.find(w => w.date === today) || {};
  const recent = [...state.wellness].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  return `<div class="card"><h3>Daily check-in</h3>
    <div class="row-3">
      <div><label>Fatigue (1–10)</label><input id="wl_fatigue" type="number" min="1" max="10" value="${cur.fatigue ?? ''}" placeholder="10 = wrecked"></div>
      <div><label>Sleep (h)</label><input id="wl_sleep" type="number" step="0.5" value="${cur.sleep ?? ''}" placeholder="hours"></div>
      <div><label>Soreness (1–10)</label><input id="wl_soreness" type="number" min="1" max="10" value="${cur.soreness ?? ''}"></div>
    </div>
    <label>Note (optional)</label><input id="wl_note" value="${escapeAttr(cur.note || '')}" placeholder="how you feel today">
    <div class="card-actions"><button class="btn primary" data-action="saveWellness">Save today's check-in</button></div>
    ${recent.length ? `<div class="stack" style="margin-top:10px">${recent.map(w => `<div class="sess"><div class="meta"><div class="t">${fmtDate(w.date + 'T12:00')}</div><div class="d">${['fatigue', 'sleep', 'soreness', 'stress'].filter(k => w[k] != null).map(k => `${k} ${w[k]}`).join(' · ')}${w.note ? ' · ' + escapeHtml(w.note) : ''}</div></div><button class="btn sm ghost" data-action="delWellness" data-date="${w.date}">✕</button></div>`).join('')}</div>` : ''}
    <p class="field-note">What you feel folds into the readiness light and the plan adaptation — and gives the AI coach real signal.</p></div>`;
}

function weightSection() {
  const wt = M.weightTrend(state.weights);
  const recent = [...state.weights].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  const today = M.dayKey(new Date());
  const cur = wt.smooth ? `${wt.smooth.toFixed(1)} ${state.settings.weightUnit} <span class="muted" style="font-size:12px">(smoothed)</span>` : 'no data';
  return `<div class="card"><div class="spread" style="margin-bottom:8px"><h3 style="margin:0">Weight</h3><span class="muted big-num">${cur}</span></div>
    <div class="row-3" style="align-items:end">
      <div><label>Date</label><input id="w_date" type="date" value="${today}"></div>
      <div><label>Weight (${state.settings.weightUnit})</label><input id="w_kg" type="number" step="0.1" placeholder="${wt.latest || ''}"></div>
      <div><button class="btn primary block" data-action="saveWeight">Log weight</button></div>
    </div>
    ${recent.length ? `<div class="stack" style="margin-top:12px">${recent.map(w => `<div class="sess" data-w="${w.date}"><div class="meta"><div class="t">${w.kg.toFixed(1)} ${state.settings.weightUnit}</div><div class="d">${fmtDate(w.date + 'T12:00')}</div></div><button class="btn sm ghost" data-action="delWeight" data-date="${w.date}">✕</button></div>`).join('')}</div>` : ''}
    <p class="field-note">Daily weight feeds energy expenditure (the fatigue model on the energy basis) and run-economy in the finish projection. Miss a day and the last value carries forward.</p>
  </div>`;
}

function testSection() {
  const tests = [...state.tests].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return `<div class="card"><div class="spread" style="margin-bottom:8px"><h3 style="margin:0">Benchmark tests</h3>
      <button class="btn sm" data-action="addTest">+ Add test</button></div>
    ${tests.length ? `<div class="stack">${tests.map(t => `<div class="sess"><div class="meta"><div class="t">${testLabel(t)}</div><div class="d">${t.date ? fmtDate(t.date + 'T12:00') : ''} · ${testValue(t)}</div></div><button class="btn sm ghost" data-action="delTest" data-id="${t.id}">✕</button></div>`).join('')}</div>`
      : '<p class="field-note">No tests yet. A 400m swim TT (with a 200m split), a 20-min run TT, or a 20-min bike TT calibrate your thresholds precisely.</p>'}
  </div>`;
}
function testLabel(t) { return ({ swim_css: 'Swim CSS test', swim_tt: 'Swim time trial', run_tt20: '20-min run TT', bike_tt20: '20-min bike TT' })[t.type] || t.type; }
function testValue(t) {
  if (t.type === 'swim_css') return `400m ${secToClock(t.t400)}, 200m ${secToClock(t.t200)} → CSS ${secToClock(100 / (200 / (t.t400 - t.t200)))}/100m`;
  if (t.type === 'swim_tt') return `${t.distanceM}m in ${secToClock(t.timeSec)}`;
  if (t.type === 'run_tt20') return `${t.distanceM}m in 20 min${t.avgHr ? ` · ${t.avgHr} bpm` : ''}`;
  if (t.type === 'bike_tt20') return `${t.avgSpeed ? (t.avgSpeed * 3.6).toFixed(1) + ' km/h' : ''}${t.avgHr ? ` · ${t.avgHr} bpm` : ''}`;
  return '';
}

// ---- PLAN -------------------------------------------------------------------

function renderPlan() {
  const weeks = PL.sessionsByWeek(state.plan);
  if (!weeks.length) {
    return `<h2 class="page-title">Plan</h2>
      <div class="card"><h3>No plan yet</h3>
        <p class="muted">Seed an editable base-building block, then reshape every session — nothing here is fixed. Since your race is a long way out, this leads with aerobic volume and technique.</p>
        <label>Weekly hours to build around</label>
        <input id="planHours" type="number" min="3" max="25" step="0.5" value="8">
        <label>Number of weeks</label>
        <input id="planWeeks" type="number" min="2" max="24" step="1" value="12">
        <div class="card-actions"><button class="btn primary" data-action="genPlan">Generate base block</button></div>
      </div>`;
  }
  // Auto-regulation
  const signals = A.fatigueSignals(state.pmc);
  const adapt = A.adaptationSuggestions(state.plan, signals, state.settings, todayWellness());
  window.__adapt = adapt.changes;
  const autoAdapt = state.settings.autoAdaptApply;
  const toggle = `<label class="toggle"><input type="checkbox" data-action="toggleAutoAdapt" ${autoAdapt ? 'checked' : ''}> Auto-apply</label>`;
  let adaptCard = '';
  if (adapt.changes.length) {
    adaptCard = `<div class="card ready-amber"><div class="spread"><h3 style="margin:0">Plan adaptation suggested</h3>${toggle}</div>
      <p class="field-note" style="margin-top:6px">${adapt.changes[0].reason}</p>
      ${adapt.changes.map(c => `<div class="diff"><div><div class="d-title">${weekdayShort(c.date)} ${c.date.slice(5)} · ${c.title}</div><div class="d-sub">${c.kind === 'reduce' ? 'ease back' : 'add a little'} · ${c.sport}</div></div>
        <div class="d-load"><span class="old">${c.fromLoad}</span> → <span class="new">${c.toLoad}</span> load</div></div>`).join('')}
      <div class="card-actions"><button class="btn primary" data-action="acceptAdapt">Apply changes</button></div></div>`;
  } else if (signals) {
    adaptCard = `<div class="card ready-green"><div class="spread"><div><b>Plan on track</b>
      <div class="muted" style="font-size:12.5px">Form ${signals.tsb.toFixed(0)}, ACWR ${signals.acwr.toFixed(2)}${signals.monotony >= (state.settings.monotonyHigh ?? 2.5) ? ` · monotony ${signals.monotony.toFixed(1)} (add variety)` : ''} — no load changes needed.</div></div>${toggle}</div></div>`;
  }
  const taperCard = state.settings.raceDate
    ? `<div class="card"><div class="spread"><div><h3 style="margin:0 0 3px">Race taper</h3><span class="muted" style="font-size:12.5px">Auto-build the final ${state.settings.taperWeeks} weeks to peak on race day (${state.settings.raceDate}).</span></div>
        <button class="btn" data-action="genTaper">Generate taper</button></div></div>` : '';

  const proj = `<div class="card"><h3>Projected fitness (actual + planned)</h3>${charts.pmcChart(state.pmc)}
    <div class="legend"><span><i style="background:var(--ctl)"></i>Fitness</span><span><i style="background:var(--atl)"></i>Fatigue</span><span><i style="background:var(--tsb)"></i>Form</span><span class="muted">shaded = planned</span></div></div>`;

  const weekCards = weeks.map(([wk, sess]) => {
    const load = sess.reduce((s, x) => s + (x.targetLoad || 0), 0);
    const hrs = sess.reduce((s, x) => s + (x.targetDurationSec || 0), 0) / 3600;
    return `<div class="week"><div class="wk-head"><b>Week of ${wk.slice(5)}</b>
      <span class="wk-load">${hrs.toFixed(1)} h · ${Math.round(load)} load</span></div>
      ${sess.map(planRow).join('')}
      <div class="psess" style="grid-template-columns:1fr"><button class="btn sm ghost" data-action="addPlanSess" data-week="${wk}">+ add session</button></div>
    </div>`;
  }).join('');

  return `<h2 class="page-title">Plan</h2>
    <div class="card"><div class="spread"><span class="muted">${state.plan.phases.map(p => p.name).join(' → ') || 'Custom'} · edit anything inline</span>
      <button class="btn sm danger" data-action="clearPlan">Clear plan</button></div></div>
    ${adaptCard}
    ${taperCard}
    ${proj}
    ${weekCards}`;
}

function planRow(s) {
  return `<div class="psess" data-id="${s.id}">
    <div class="pd">${weekdayShort(s.date)}<br>${s.date.slice(8)}</div>
    <div><input class="title-in" data-pf="title" value="${escapeAttr(s.title)}" placeholder="${cap(s.sport)} session"></div>
    <select data-pf="sport" style="width:92px">${SPORTS.map(sp => `<option ${sp === s.sport ? 'selected' : ''}>${sp}</option>`).join('')}</select>
    <div style="display:flex;gap:6px;align-items:center">
      <input data-pf="min" type="number" min="0" step="5" value="${Math.round((s.targetDurationSec || 0) / 60)}" style="width:60px" title="minutes">
      <span class="muted" style="font-size:12px;width:40px;text-align:right">${s.targetLoad || 0}</span>
      <button class="btn sm ghost" data-action="exportWorkout" title="Export to Garmin">⌚</button>
      <button class="btn sm ghost" data-action="delPlanSess" title="delete">✕</button>
    </div>
  </div>`;
}

// ---- COACH (predictions + self-calibration + estimates) ---------------------

function renderCoach() {
  if (!state.activities.length) return `<h2 class="page-title">Coach</h2><div class="card chart-empty">Import or log some sessions and the model will start estimating your thresholds, zones and predictions.</div>`;
  const est = state.est;
  const pred = E.predict(state.activities, state.settings, state.weights, state.tests, state.pmc, est);
  const cal = E.calibrateModel(state.activities, state.settings, state.weights);
  const proxy = E.performanceProxy(state.activities, state.settings);
  const s = state.settings;

  // Readiness (only if a race date is set)
  let readinessCard = '';
  if (pred.readiness) {
    const r = pred.readiness;
    readinessCard = `<div class="card"><h3>Race readiness · ${r.daysOut} days out</h3>
      <div class="readiness">
        <div class="gauge" style="--v:${r.score}"><span class="g-num">${r.score}</span></div>
        <div class="r-parts">
          ${rPart('Form', r.parts.formScore)}
          ${rPart('Fitness', r.parts.fitnessScore)}
          ${rPart('Weight', r.parts.weightScore)}
          <p class="field-note">Projected form (TSB) ${r.tsb > 0 ? '+' : ''}${r.tsb.toFixed(0)}, fitness ${r.ctl.toFixed(0)} at race day. Form is weighted highest — being fresh on the day matters most.</p>
        </div>
      </div></div>`;
  } else {
    readinessCard = `<div class="card"><div class="hint">Set a race date in Setup to unlock a readiness score and a race-day form projection.</div></div>`;
  }

  // Today's predicted efforts
  const ef = pred.efforts;
  const effortCard = `<div class="card"><h3>What you could do today</h3>
    <div class="pred-grid">
      ${predBox('5 km', ef.run5k ? hms(ef.run5k) : '—', 'run')}
      ${predBox('10 km', ef.run10k ? hms(ef.run10k) : '—', 'run')}
      ${predBox('Run threshold', ef.runThresholdPace ? clockPace(ef.runThresholdPace) : '—', '/km')}
      ${predBox('Swim CSS', ef.cssPace ? clockPace(ef.cssPace) : '—', '/100m')}
      ${predBox('Threshold HR', ef.thresholdHr || '—', 'bpm')}
    </div>
    <p class="field-note">Predicted from your estimated thresholds, nudged ${pred.formBonus >= 0 ? '+' : ''}${(pred.formBonus * 100).toFixed(1)}% by today's form. Log a benchmark test to sharpen these.</p>
  </div>`;

  // Ironman projection
  let imCard = '';
  if (pred.ironman) {
    const im = pred.ironman;
    imCard = `<div class="card"><h3>Ironman finish projection</h3>
      <table class="kv"><tbody>
        <tr><td>Swim · 3.8 km</td><td class="num">${im.swimSec ? hms(im.swimSec) : '—'}</td><td class="src">${est.cssSpeed.value ? clockPace(100 / (est.cssSpeed.value / s.imSwimFactor)) + ' /100m' : ''}</td></tr>
        <tr><td>Bike · 180 km</td><td class="num">${hms(im.bikeSec)}</td><td class="src">${im.bikeKmh.toFixed(1)} km/h</td></tr>
        <tr><td>Run · 42.2 km</td><td class="num">${hms(im.runSec)}</td><td class="src">${clockPace(im.marathonPacePerKm)} /km</td></tr>
        <tr><td>Transitions</td><td class="num">${hms(im.transitions)}</td><td></td></tr>
        <tr style="font-weight:700"><td>Total</td><td class="num">${hms(im.total)}</td><td></td></tr>
      </tbody></table>
      <p class="field-note">${im.note} Tune the swim/bike/run intensity assumptions in Setup.</p>
    </div>`;
  }

  // Best efforts (mean-max from parsed streams)
  const curve = E.bestEffortCurve(state.activities);
  const durLabels = { '5': '5 min', '10': '10 min', '20': '20 min', '30': '30 min', '60': '60 min' };
  const sportsWith = Object.keys(curve);
  const bestCard = sportsWith.length ? `<div class="card"><h3>Best efforts (mean-max)</h3>
    ${sportsWith.map(sp => { const row = curve[sp]; const ds = Object.keys(row);
      return `<div style="margin-bottom:12px"><div class="muted" style="font-size:12px;text-transform:capitalize;margin-bottom:4px">${sp}</div>
        <table class="kv"><thead><tr><th>Window</th><th class="num">${sp === 'bike' ? 'km/h' : sp === 'swim' ? '/100m' : '/km'}</th><th class="num">HR</th></tr></thead><tbody>
        ${ds.map(d => `<tr><td>${durLabels[d]}</td><td class="num">${fmtEffort(sp, row[d].speed)}</td><td class="num">${row[d].hr || '—'}</td></tr>`).join('')}</tbody></table></div>`;
    }).join('')}
    <p class="field-note">Best sustained pace and HR over each window, extracted from your file streams (not just session averages). This is what sharpens the threshold estimates below.</p></div>` : '';

  // Aerobic trend + self-calibration
  const trendCard = `<div class="card"><h3>Aerobic performance trend</h3>
    ${charts.trendChart(proxy, { empty: 'Need more steady HR sessions to plot your fitness→speed trend.' })}
    <p class="field-note">Efficiency index (speed per heartbeat, normalized across sports). Rising = the same pace is costing you fewer beats — real aerobic progress. This is the signal the model calibrates against.</p></div>`;

  let calCard;
  if (cal.ok) {
    const changed = cal.tau1 !== s.ctlDays || cal.tau2 !== s.atlDays;
    const trust = cal.r2 >= 0.3;
    calCard = `<div class="card"><h3>Self-calibrating fatigue/form model</h3>
      <table class="kv"><thead><tr><th></th><th class="num">Now</th><th class="num">Best fit</th></tr></thead><tbody>
        <tr><td>Fitness τ (days)</td><td class="num">${s.ctlDays}</td><td class="num">${cal.tau1}</td></tr>
        <tr><td>Fatigue τ (days)</td><td class="num">${s.atlDays}</td><td class="num">${cal.tau2}</td></tr>
        <tr><td>Fitness gain k₁ / Fatigue gain k₂</td><td class="num">—</td><td class="num">${cal.k1.toFixed(2)} / ${cal.k2.toFixed(2)}</td></tr>
        <tr><td>Model fit R²</td><td class="num">—</td><td class="num">${cal.r2.toFixed(2)} <span class="conf ${cal.quality === 'strong' ? 'high' : cal.quality === 'moderate' ? 'med' : 'low'}">${cal.quality}</span></td></tr>
      </tbody></table>
      <p class="field-note">Fitted to ${cal.n} performance points from your history. ${!changed ? 'Your current constants already match the best fit.' : trust ? 'Accepting updates your Fitness/Fatigue curves everywhere.' : `The fit is ${cal.quality} (R² ${cal.r2.toFixed(2)}) — I'd keep ${s.ctlDays}/${s.atlDays} until you have more steady-HR history or a benchmark test.`}</p>
      ${changed ? `<div class="card-actions"><button class="btn ${trust ? 'primary' : 'ghost'}" data-action="acceptCal" data-t1="${cal.tau1}" data-t2="${cal.tau2}">${trust ? 'Accept best-fit constants' : 'Apply anyway (weak fit)'}</button></div>` : ''}
    </div>`;
  } else {
    calCard = `<div class="card"><h3>Self-calibrating fatigue/form model</h3>
      <p class="muted">${cal.reason}</p>
      <p class="field-note">The model fits its time constants to your own performance trend once there's enough steady-HR history. Until then it uses the standard 42/7-day constants.</p></div>`;
  }

  // Estimated thresholds
  const estRows = [
    estRow('Max HR', 'maxHr', est.maxHr, s.maxHr, v => `${v} bpm`),
    estRow('Resting HR', 'restHr', est.restHr, s.restHr, v => `${v} bpm`),
    estRow('Threshold HR', 'lthr', est.lthr, s.lthr, v => `${v} bpm`),
    estRow('Swim CSS', 'cssSpeed', est.cssSpeed, s.cssSpeed, v => `${clockPace(100 / v)} /100m`),
    estRow('Run threshold', 'runThresholdSpeed', est.runThresholdSpeed, s.runThresholdSpeed, v => `${clockPace(1000 / v)} /km`),
  ].join('');
  const estCard = `<div class="card"><h3>Estimated from your history</h3>
    <table class="kv"><thead><tr><th>Metric</th><th>Estimate</th><th>Current</th><th></th></tr></thead><tbody>${estRows}</tbody></table>
    <p class="field-note">Estimates use your best sustained 20-minute efforts (parsed from the file streams) where available, falling back to session averages, and are anchored by any benchmark tests. Accept one to use it as your setting; low-confidence values want a real test (Log → Add test).</p></div>`;

  // Zones
  const z = est.zones;
  const zoneCard = (z.hr.length || z.runPace.length) ? `<div class="card"><h3>Training zones</h3>
    ${z.hr.length ? `<table class="kv zone-table"><thead><tr><th>HR zone (${s.zoneModel === 'lthr' ? '% LTHR' : '% max'})</th><th class="num">bpm</th></tr></thead><tbody>
      ${z.hr.map(zz => `<tr><td class="zc">${zz.z}</td><td class="num">${zz.lo || ''}${zz.hi ? '–' + zz.hi : (zz.lo ? '+' : '')}</td></tr>`).join('')}</tbody></table>` : ''}
    ${z.runPace.length ? `<table class="kv zone-table" style="margin-top:12px"><thead><tr><th>Run pace</th><th class="num">/km</th></tr></thead><tbody>
      ${z.runPace.map(zz => `<tr><td class="zc">${zz.z}</td><td class="num">${zz.range.replace(' /km','')}</td></tr>`).join('')}</tbody></table>` : ''}
    ${z.swimPace.length ? `<table class="kv zone-table" style="margin-top:12px"><thead><tr><th>Swim pace</th><th class="num">/100m</th></tr></thead><tbody>
      ${z.swimPace.map(zz => `<tr><td class="zc">${zz.z}</td><td class="num">${zz.range.replace(' /100m','')}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>` : '';

  // Race-day plan
  const rp = racePlan(pred, est, s, (pred.weight && pred.weight.current) || s.defaultWeightKg);
  const raceCard = rp ? `<div class="card"><h3>Race-day plan</h3>
    <table class="kv"><thead><tr><th>Leg</th><th>Split</th><th>Target</th><th class="num">HR</th></tr></thead><tbody>
    ${rp.pacing.map(l => `<tr><td>${l.leg}</td><td>${l.time}</td><td>${l.target}</td><td class="num">${l.hr}</td></tr>`).join('')}</tbody></table>
    <div class="pred-grid" style="margin-top:12px">
      ${predBox('Carbs/hr', rp.fuelling.perHour.carbs, 'g')}
      ${predBox('Fluid/hr', rp.fuelling.perHour.fluidMl, 'ml')}
      ${predBox('Sodium/hr', rp.fuelling.perHour.sodiumMg, 'mg')}
      ${predBox('Total carbs', rp.fuelling.totals.carbsG, 'g bike+run')}</div>
    <p class="field-note">${rp.fuelling.note} Estimated burn ~${rp.fuelling.estimatedBurnKcal} kcal. Adjust rates in Setup.</p></div>` : '';

  // Durability (aerobic decoupling)
  const dur = E.durability(state.activities);
  const durBody = dur.points.length >= 3
    ? charts.trendChart(dur.points)
    : `<div class="pred-grid"><div class="pred"><div class="pk">Recent avg</div><div class="pv">${dur.avg != null ? dur.avg.toFixed(1) : '—'}<span class="pu"> %</span></div></div>
        <div class="pred"><div class="pk">Latest</div><div class="pv">${dur.latest != null ? dur.latest.toFixed(1) : '—'}<span class="pu"> %</span></div></div>
        <div class="pred"><div class="pk">Long sessions</div><div class="pv">${dur.n}</div></div></div>`;
  const durabilityCard = dur.n ? `<div class="card"><h3>Durability — aerobic decoupling</h3>
    ${durBody}
    <p class="field-note">Lower is better: how much your pace-per-heartbeat fades over a long session. Recent average ${dur.avg != null ? dur.avg.toFixed(1) + '%' : '—'}. Under ~5% is strong Ironman durability — a rising trend means the endurance base needs more long, steady work.</p></div>` : '';

  const dueMsg = testDue(s, state.tests);
  const testCard = dueMsg ? `<div class="card ready-amber"><div class="spread"><div><b>Time for a benchmark test</b>
    <div class="muted" style="font-size:12.5px">${dueMsg}</div></div><button class="btn" data-action="addTest">Log a test</button></div></div>` : '';

  return `<h2 class="page-title">Coach</h2>
    ${testCard}
    ${readinessCard}
    ${effortCard}
    ${imCard}
    ${raceCard}
    ${bestCard}
    ${durabilityCard}
    ${trendCard}
    ${calCard}
    ${estCard}
    ${zoneCard}`;
}

function testDue(settings, tests) {
  const last = [...(tests || [])].map(t => t.date).filter(Boolean).sort().slice(-1)[0] || settings.lastTestDate;
  const interval = settings.testIntervalWeeks || 6;
  if (!last) return `No benchmark test logged yet — a 20-min run TT or a 400 m swim TT will lock in your thresholds.`;
  const weeks = (Date.now() - new Date(last).getTime()) / (7 * 86400000);
  if (weeks >= interval) return `Last test was ${Math.floor(weeks)} weeks ago (you test every ${interval}). A fresh one keeps the estimates honest.`;
  return null;
}

function fmtEffort(sport, speed) {
  if (!Number.isFinite(speed) || speed <= 0) return '—';
  if (sport === 'bike') return (speed * 3.6).toFixed(1);
  if (sport === 'swim') return secToClock(100 / speed);
  return secToClock(1000 / speed);
}

function rPart(label, v) {
  return `<div class="r-part"><span>${label}</span><span class="bar-track"><span class="bar-fill" style="width:${v}%;background:var(--accent)"></span></span><span class="right">${v}</span></div>`;
}
function predBox(k, v, u) { return `<div class="pred"><div class="pk">${k}</div><div class="pv">${v}</div><div class="pu">${u}</div></div>`; }
function estRow(label, field, e, current, fmt) {
  const val = e && e.value != null;
  const cur = current != null && current !== 0 ? fmt(current) : '—';
  const badge = val ? `<span class="conf ${e.confidence}">${e.confidence}</span>` : '';
  const srcText = val && e.source === 'test' ? 'from test' : val && e.source === '20-min effort' ? 'best 20-min' : '';
  const src = srcText ? `<div class="src">${srcText}</div>` : '';
  const accept = val ? `<button class="btn sm acc-btn" data-action="acceptEst" data-field="${field}" data-val="${e.value}">Accept</button>` : '';
  return `<tr><td>${label}</td><td>${val ? fmt(e.value) : '—'} ${badge}${src}</td><td>${cur}</td><td class="right">${accept}</td></tr>`;
}

// ---- STATS ------------------------------------------------------------------

function renderStats() {
  if (!state.activities.length) return `<h2 class="page-title">Stats</h2><div class="card chart-empty">Import or add sessions to see your analytics.</div>`;
  const weeks = M.weeklyVolume(state.activities, state.settings);
  const since = M.addDays(M.dayKey(new Date()), -42);
  const recent = state.activities.filter(a => M.dayKey(a.startTime) >= since);
  const bySportLoad = {};
  const bySportSecs = {};
  for (const a of recent) {
    const { load } = M.activityLoad(a, state.settings);
    bySportLoad[a.sport] = (bySportLoad[a.sport] || 0) + load;
    bySportSecs[a.sport] = (bySportSecs[a.sport] || 0) + (a.durationSec || 0);
  }
  const totalHrs = state.activities.reduce((s, a) => s + (a.durationSec || 0), 0) / 3600;
  const totalSess = state.activities.length;
  const lastW = weeks.slice(-1)[0];

  return `<h2 class="page-title">Stats</h2>
    <div class="tiles">
      <div class="tile"><div class="k">Sessions</div><div class="v">${totalSess}</div></div>
      <div class="tile"><div class="k">Total hours</div><div class="v">${totalHrs.toFixed(0)}</div></div>
      <div class="tile"><div class="k">This week</div><div class="v">${lastW ? lastW.hours.toFixed(1) : '0'}</div><div class="u">hours</div></div>
    </div>
    <div class="card"><h3>Weekly volume (hours by sport)</h3>${charts.weeklyVolumeChart(weeks, SPORT_COLORS)}
      <div class="legend">${SPORTS.map(sp => `<span><i style="background:${SPORT_COLORS[sp]};height:10px;width:10px;border-radius:3px"></i>${sp}</span>`).join('')}</div></div>
    <div class="card"><h3>Load balance — last 6 weeks</h3>${charts.loadBySportChart(bySportLoad, SPORT_COLORS)}
      <p class="field-note">Ironman rewards bike and run volume, but don't let the swim slide — it's where technique compounds slowest.</p></div>
    <div class="card"><h3>Time by sport — last 6 weeks</h3>${charts.loadBySportChart(Object.fromEntries(Object.entries(bySportSecs).map(([k,v])=>[k,v/3600])), SPORT_COLORS)}</div>
    ${weightStatsCard()}
    ${energyStatsCard()}`;
}

function weightStatsCard() {
  const wt = M.weightTrend(state.weights);
  if (!wt.series.length) return `<div class="card"><h3>Weight</h3><div class="chart-empty">Log your weight (in the Log tab) to track the trend.</div></div>`;
  return `<div class="card"><h3>Weight trend</h3>${charts.weightChart(wt.series)}
    <p class="field-note">Smoothed ${wt.smooth.toFixed(1)} ${state.settings.weightUnit}${wt.dropPct7 > 0.5 ? ` · down ${wt.dropPct7.toFixed(1)}% over the last week — watch fuelling` : ''}.</p></div>`;
}

function energyStatsCard() {
  const since = M.addDays(M.dayKey(new Date()), -42);
  const recent = state.pmc.filter(p => !p.isFuture && p.day >= since && p.energy > 0);
  if (!recent.length) return '';
  const total = recent.reduce((s, p) => s + p.energy, 0);
  const days = new Set(recent.map(p => p.day)).size;
  const avg = total / Math.max(1, days);
  return `<div class="card"><h3>Training energy — last 6 weeks</h3>
    <div class="tiles"><div class="tile"><div class="k">Avg / training day</div><div class="v">${Math.round(avg)}</div><div class="u">kcal</div></div>
      <div class="tile"><div class="k">6-week total</div><div class="v">${(total/1000).toFixed(1)}k</div><div class="u">kcal</div></div>
      <div class="tile"><div class="k">Load basis</div><div class="v" style="font-size:18px">${basisLabel(state.settings).name}</div><div class="u">${basisLabel(state.settings).sub}</div></div></div>
    <p class="field-note">Estimated from HR + body weight (Keytel). In Setup you can run the fitness model on energy, or Combined — a blend of HR-strain and calories — so your weight feeds fatigue directly.</p></div>`;
}

// ---- AI ---------------------------------------------------------------------

function renderAi() {
  const s = state.settings;
  const configured = s.aiEngine === 'local' ? true : !!(s.aiBaseUrl && s.aiModel);
  const engineLabel = s.aiEngine === 'local' ? `On-device · ${s.aiLocalModel.split('-').slice(0, 3).join('-')}` : (s.aiModel || 'not configured');

  const chatMsgs = state.chat.map(m => `<div class="chat-msg ${m.role}"><div class="bubble">${m.role === 'assistant' ? mdLite(escapeHtml(m.content)) : escapeHtml(m.content)}</div></div>`).join('');
  const pending = state.pendingActions;
  const pendingCard = pending && pending.describe.length ? `<div class="card ready-amber"><h3>Proposed changes — your approval</h3>
    ${pending.describe.map(d => `<div class="diff"><div><div class="d-title">${d.blocked ? '⚠︎ ' : ''}${escapeHtml(d.summary)}</div>${d.detail ? `<div class="d-sub">${escapeHtml(d.detail)}</div>` : ''}</div></div>`).join('')}
    <div class="card-actions"><button class="btn primary" data-action="approveActions">Apply changes</button><button class="btn ghost" data-action="dismissActions">Dismiss</button></div></div>` : '';

  const journalCard = `<div class="card"><div class="spread"><h3 style="margin:0">Journal</h3><button class="btn sm" data-action="addJournal">+ Note</button></div>
    ${state.journal.length ? `<div class="stack" style="margin-top:8px">${state.journal.slice(0, 20).map(j => `<div class="sess"><div class="meta"><div class="t">${fmtDate((j.date || M.dayKey(new Date())) + 'T12:00')} ${j.source === 'ai' ? '<span class="pill">AI</span>' : ''}</div><div class="d">${escapeHtml(j.text)}</div></div><button class="btn sm ghost" data-action="delJournal" data-id="${j.id}">✕</button></div>`).join('')}</div>`
      : '<p class="field-note">Your training journal — how sessions felt, life stress, niggles. The coach reads it and writes to it.</p>'}
  </div>`;

  const payload = buildAiPayload(state.activities, state.settings, state.plan, state.weights, state.tests);
  window.__ai = { payload, prompt: buildPrompt(payload), preview: JSON.stringify(payload, null, 2) };

  return `<h2 class="page-title">AI Coach</h2>
    <div class="card"><div class="spread"><span class="muted" style="font-size:12.5px">Engine: ${engineLabel}</span><button class="btn sm ghost" data-action="goto" data-tab="setup">Configure</button></div>
      <div class="chat" id="chatBox">${chatMsgs || '<div class="chart-empty">Ask your coach anything, or tell it how you feel — e.g. "slept badly, legs are toast, ease this week" — and it can adjust your plan (you approve first).</div>'}</div>
      ${state.aiBusy ? '<div class="muted" style="font-size:13px;padding:8px 2px">Coach is thinking…</div>' : ''}
      <div class="chat-input"><textarea id="chatInput" rows="2" placeholder="Message your coach…"></textarea><button class="btn primary" data-action="sendChat">Send</button></div>
      ${!configured ? '<p class="field-note">Set up an engine first: Setup → AI coach (a cloud endpoint, or the on-device model).</p>' : ''}
      ${state.chat.length ? '<div class="card-actions"><button class="btn sm ghost" data-action="clearChat">Clear chat</button></div>' : ''}
    </div>
    ${pendingCard}
    ${journalCard}
    <div class="card"><h3>Manual export (fallback)</h3><p class="field-note" style="margin-top:0">No engine set up? Copy your data into any AI by hand.</p>
      <div class="card-actions"><button class="btn" data-action="copyPrompt">Copy prompt + data</button><button class="btn ghost" data-action="dlJson">Download JSON</button></div></div>`;
}

// tiny, safe markdown: input must already be HTML-escaped
function mdLite(escaped) {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}

// ---- SETUP ------------------------------------------------------------------

function renderSetup() {
  const s = state.settings;
  return `<h2 class="page-title">Setup</h2>
    <div class="card"><h3>Goal</h3>
      <label>Race name / goal</label><input id="s_raceName" value="${escapeAttr(s.raceName)}" placeholder="e.g. Ironman Copenhagen">
      <label>Race date <span class="muted">(leave blank while base building)</span></label><input id="s_raceDate" type="date" value="${s.raceDate || ''}">
    </div>
    <div class="card"><h3>Heart-rate anchors</h3><p class="field-note" style="margin-top:-2px">These drive every HR-based load number. Set them from real data — a max-HR effort and a true resting HR.</p>
      <div class="row"><div><label>Max HR</label><input id="s_maxHr" type="number" value="${s.maxHr}"></div>
        <div><label>Resting HR</label><input id="s_restHr" type="number" value="${s.restHr}"></div></div>
    </div>
    <div class="card"><h3>Thresholds (for sport-specific scores)</h3>
      <div class="row"><div><label>Critical Swim Speed — pace /100m</label><input id="s_css" value="${secToClock(s.cssSpeed ? 100 / s.cssSpeed : 0)}" placeholder="1:40"></div>
        <div><label>Run threshold — pace /km</label><input id="s_run" value="${secToClock(s.runThresholdSpeed ? 1000 / s.runThresholdSpeed : 0)}" placeholder="4:30"></div></div>
      <p class="field-note">Swim: from a 400 m time trial. Run: from a 30-minute time trial (use the last 20 min average).</p>
    </div>
    <div class="card"><h3>Model parameters</h3>
      <div class="row-3">
        <div><label>Fitness τ (days)</label><input id="s_ctl" type="number" value="${s.ctlDays}"></div>
        <div><label>Fatigue τ (days)</label><input id="s_atl" type="number" value="${s.atlDays}"></div>
        <div><label>TRIMP weight b</label><input id="s_b" type="number" step="0.01" value="${s.trimpB}"></div>
      </div>
      <div class="row-3">
        <div><label>Deep-fatigue TSB</label><input id="s_deep" type="number" value="${s.tsbDeepFatigue}"></div>
        <div><label>Very-fresh TSB</label><input id="s_fresh" type="number" value="${s.tsbVeryFresh}"></div>
        <div><label>Ramp warn /wk</label><input id="s_ramp" type="number" value="${s.rampWarn}"></div>
      </div>
      <p class="field-note">Defaults follow the standard 42/7-day model. Lower the fitness τ if you want the chart to react faster to recent weeks.</p>
    </div>
    <div class="card"><h3>Energy &amp; weight</h3>
      <div class="row-3">
        <div><label>Age <span class="muted">(for kcal)</span></label><input id="s_age" type="number" value="${s.age || ''}" placeholder="e.g. 34"></div>
        <div><label>Weight unit</label><select id="s_wunit"><option ${s.weightUnit === 'kg' ? 'selected' : ''}>kg</option><option ${s.weightUnit === 'lb' ? 'selected' : ''}>lb</option></select></div>
        <div><label>Default weight</label><input id="s_dweight" type="number" step="0.1" value="${s.defaultWeightKg}"></div>
      </div>
      <label>Fitness model load basis</label>
      <select id="s_basis"><option value="trimp" ${s.loadBasis === 'trimp' ? 'selected' : ''}>TRIMP — heart-rate strain (default)</option><option value="energy" ${s.loadBasis === 'energy' ? 'selected' : ''}>Energy — kcal, driven by weight + HR</option><option value="combined" ${s.loadBasis === 'combined' ? 'selected' : ''}>Combined — blend of both</option></select>
      <label>Combined blend <span class="muted">(only used on the Combined basis)</span></label>
      <div class="spread"><span class="muted" style="font-size:12px">TRIMP</span>
        <input id="s_blend" type="range" min="0" max="100" step="5" value="${Math.round((s.energyBlend ?? 0.5) * 100)}" style="flex:1;margin:0 10px">
        <span class="muted" style="font-size:12px">Energy</span></div>
      <p class="field-note"><b><span id="s_blend_val">${Math.round((s.energyBlend ?? 0.5) * 100)}</span>% energy</b> — Combined blends HR-strain and calories on a common scale, so body weight feeds fatigue without discarding the cardiovascular signal. Energy is rescaled to TRIMP's range first, so your Fitness/Fatigue numbers stay familiar whatever you pick.</p>
    </div>
    <div class="card"><h3>Ironman projection assumptions</h3>
      <div class="row-3">
        <div><label>Swim pace factor</label><input id="s_imswim" type="number" step="0.01" value="${s.imSwimFactor}"></div>
        <div><label>Bike target km/h <span class="muted">(0=auto)</span></label><input id="s_imbike" type="number" step="0.1" value="${s.imBikeTargetKmh}"></div>
        <div><label>Run pace factor</label><input id="s_imrun" type="number" step="0.01" value="${s.imRunFactor}"></div>
      </div>
      <div class="row">
        <div><label>Transitions (min)</label><input id="s_trans" type="number" value="${s.transitionsMin}"></div>
        <div><label>Run economy %/kg-% </label><input id="s_econ" type="number" step="0.1" value="${s.weightEconomyPct}"></div>
      </div>
      <p class="field-note">Swim/run factors are how much slower than threshold you hold over the full distance (1.10 = 10% slower). Bike defaults to your recent long-ride speed.</p>
    </div>
    <div class="card"><h3>Auto-regulation &amp; race</h3>
      <label class="toggle" style="margin:2px 0 10px"><input id="s_autoadapt" type="checkbox" ${s.autoAdaptApply ? 'checked' : ''}> Auto-apply plan adaptations when I open the Plan tab</label>
      <div class="row-3">
        <div><label>ACWR high</label><input id="s_acwrhi" type="number" step="0.1" value="${s.acwrHigh}"></div>
        <div><label>Monotony high</label><input id="s_mono" type="number" step="0.1" value="${s.monotonyHigh}"></div>
        <div><label>Ease cut %</label><input id="s_cut" type="number" step="5" value="${Math.round((s.adaptCutPct ?? 0.6) * 100)}"></div>
      </div>
      <div class="row"><div><label>Taper weeks</label><input id="s_taper" type="number" value="${s.taperWeeks}"></div>
        <div><label>Test every (weeks)</label><input id="s_testiv" type="number" value="${s.testIntervalWeeks}"></div></div>
      <label>Race fuelling — per hour of bike + run</label>
      <div class="row-3">
        <div><label>Carbs (g)</label><input id="s_carbs" type="number" value="${s.fuelCarbsPerHr}"></div>
        <div><label>Fluid (ml)</label><input id="s_fluid" type="number" value="${s.fuelFluidMlPerHr}"></div>
        <div><label>Sodium (mg)</label><input id="s_sodium" type="number" value="${s.fuelSodiumMgPerHr}"></div>
      </div>
      <p class="field-note">ACWR &gt; high or form below your deep-fatigue line eases the next hard sessions; high monotony is a "add variety" nudge, not a cut.</p>
    </div>
    <div class="card"><h3>AI coach</h3>
      <label>Engine</label>
      <select id="s_aiengine"><option value="cloud" ${s.aiEngine === 'cloud' ? 'selected' : ''}>Cloud endpoint (OpenAI-compatible)</option><option value="local" ${s.aiEngine === 'local' ? 'selected' : ''}>On-device (WebLLM, WebGPU)</option></select>
      <label>Endpoint base URL <span class="muted">(cloud)</span></label>
      <input id="s_aibase" value="${escapeAttr(s.aiBaseUrl)}" placeholder="https://openrouter.ai/api/v1 · http://localhost:11434/v1">
      <div class="row"><div><label>Model</label><input id="s_aimodel" value="${escapeAttr(s.aiModel)}" placeholder="e.g. gpt-4o-mini"></div>
        <div><label>API key <span class="muted">(if needed)</span></label><input id="s_aikey" type="password" value="${escapeAttr(s.aiApiKey)}" placeholder="stored on device only"></div></div>
      <label>On-device model <span class="muted">(WebLLM id)</span></label>
      <input id="s_ailocal" value="${escapeAttr(s.aiLocalModel)}">
      <label style="margin-top:12px">The coach may edit (each still needs your approval)</label>
      <div class="chips" id="aiScopes">${['journal', 'wellness', 'plan', 'thresholds'].map(k => `<span class="chip" data-action="toggleScope" data-scope="${k}" aria-pressed="${!!(s.aiScopes && s.aiScopes[k])}">${cap(k)}</span>`).join('')}</div>
      <label>Perceived-fatigue weight in readiness</label><input id="s_subj" type="number" step="0.5" value="${s.aiSubjectiveWeight ?? 1}">
      <p class="field-note">Cloud works with any OpenAI-compatible API (OpenRouter, Groq, OpenAI, or a local Ollama/LM Studio server). On-device runs a small model in the browser via WebGPU — big first download, no key, fully private. Your key stays on this device and is sent only to your chosen endpoint.</p>
    </div>
    <div class="card"><h3>Strava</h3>
      <label>Access token <span class="muted">(paste a personal token; see README for auto-refresh)</span></label>
      <input id="s_strava" value="${escapeAttr(s.stravaAccessToken)}" placeholder="paste Strava access token">
      <p class="field-note">Tokens expire ~6 hours. For hands-off sync, deploy the serverless helper in the README.</p>
    </div>
    <div class="card"><div class="card-actions"><button class="btn primary" data-action="saveSettings">Save settings</button></div></div>
    <div class="card"><h3>Your data</h3>
      <div class="card-actions">
        <button class="btn" data-action="backupExport">Export backup (JSON)</button>
        <button class="btn ghost" data-action="backupImport">Import backup</button>
        <button class="btn danger" data-action="wipe">Delete all data</button>
      </div>
      <p class="field-note">${state.activities.length} sessions stored locally. The backup is a full copy you own — settings, plan, weights, tests and every session.</p>
      <p class="field-note" id="storageStatus">Checking storage…</p>
    </div>
    <p class="sub right">IronPath · local-first · v1</p>`;
}

// ---- view-level event binding ----------------------------------------------

function bindView() {
  const view = document.getElementById('view');
  view.onclick = async (e) => {
    const t = e.target.closest('[data-action]'); if (!t) return;
    const act = t.dataset.action;
    try { await ACTIONS[act]?.(t, e); }
    catch (err) { toast(err.message || String(err), 'err'); console.error(err); }
  };
  // plan inline edits
  view.oninput = (e) => {
    if (e.target.id === 's_blend') { const el = document.getElementById('s_blend_val'); if (el) el.textContent = e.target.value; return; }
    const pf = e.target.dataset.pf; if (!pf) return;
    const row = e.target.closest('.psess'); const id = row?.dataset.id;
    onPlanEdit(id, pf, e.target.value);
  };
}

const ACTIONS = {
  import: () => document.getElementById('fileInput').click(),
  goto: async (t) => { state.tab = t.dataset.tab; if (state.tab === 'plan') await applyPendingAdapt(); render(); },
  add: () => openSessionModal(null),
  openSess: (t) => { const a = state.activities.find(x => x.id === t.dataset.id); if (a) openSessionModal(a); },
  strava: () => syncStrava(),
  genPlan: () => genPlan(),
  clearPlan: async () => { if (confirm('Clear the whole plan?')) { state.plan = { phases: [], sessions: [] }; await store.savePlan(state.plan); recompute(); render(); } },
  addPlanSess: async (t) => { const wk = t.dataset.week; state.plan.sessions.push(PL.newSession(wk, 'run')); await savePlanRecompute(); },
  delPlanSess: async (t) => { const id = t.closest('.psess').dataset.id; state.plan.sessions = state.plan.sessions.filter(s => s.id !== id); await savePlanRecompute(); },
  saveSettings: () => saveSettings(),
  backupExport: () => backupExport(),
  backupImport: () => document.getElementById('backupInput').click(),
  wipe: () => wipeData(),
  copyPrompt: () => copyText(window.__ai.prompt, 'Prompt + data copied — paste into Claude.'),
  copyJson: () => copyText(window.__ai.preview, 'JSON copied.'),
  dlJson: () => download('ironpath-export.json', window.__ai.preview),
  saveWeight: () => saveWeight(),
  delWeight: async (t) => { await store.deleteWeight(t.dataset.date); state.weights = await store.getAllWeights(); recompute(); render(); },
  addTest: () => openTestModal(),
  delTest: async (t) => { await store.deleteTest(t.dataset.id); state.tests = await store.getAllTests(); recompute(); render(); toast('Test removed.', 'ok'); },
  acceptEst: (t) => acceptEstimate(t.dataset.field, parseFloat(t.dataset.val)),
  acceptCal: (t) => acceptCalibration(parseInt(t.dataset.t1), parseInt(t.dataset.t2)),
  acceptAdapt: () => acceptAdapt(),
  toggleAutoAdapt: (t) => toggleAutoAdapt(t.checked),
  genTaper: () => genTaper(),
  exportWorkout: (t) => { const s = state.plan.sessions.find(x => x.id === t.closest('.psess').dataset.id); if (s) openWorkoutModal(s); },
  stravaStreams: () => fetchStravaStreamsForRecent(),
  saveWellness: () => saveWellness(),
  delWellness: async (t) => { await store.deleteWellness(t.dataset.date); state.wellness = await store.getAllWellness(); recompute(); render(); },
  sendChat: () => sendChat(),
  clearChat: () => { state.chat = []; state.pendingActions = null; render(); },
  approveActions: () => approveActions(),
  dismissActions: () => { state.pendingActions = null; render(); },
  addJournal: () => addJournalPrompt(),
  delJournal: async (t) => { await store.deleteJournalEntry(t.dataset.id); state.journal = await store.getAllJournal(); render(); },
  toggleScope: (t) => { t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') !== 'true'); },
};

async function saveWellness() {
  const today = M.dayKey(new Date());
  const e = { ...(state.wellness.find(w => w.date === today) || {}), date: today };
  const f = intOrNull(val('wl_fatigue')); const sl = parseFloat(val('wl_sleep')); const so = intOrNull(val('wl_soreness'));
  if (f != null) e.fatigue = Math.max(1, Math.min(10, f));
  if (Number.isFinite(sl)) e.sleep = sl;
  if (so != null) e.soreness = Math.max(1, Math.min(10, so));
  e.note = val('wl_note').trim();
  await store.putWellness(e); state.wellness = await store.getAllWellness();
  recompute(); render(); toast("Today's check-in saved.", 'ok');
}

async function sendChat() {
  const inp = document.getElementById('chatInput'); const msg = (inp?.value || '').trim(); if (!msg) return;
  const s = state.settings;
  const ready = s.aiEngine === 'local' ? WL.webgpuAvailable() : (s.aiBaseUrl && s.aiModel);
  if (!ready) { toast(s.aiEngine === 'local' ? 'No WebGPU here — use a cloud endpoint.' : 'Configure an AI endpoint in Setup first.', 'err'); state.tab = 'setup'; render(); return; }
  state.chat.push({ role: 'user', content: msg }); state.aiBusy = true; render();
  try {
    const ctx = AI.buildContext(state);
    const history = state.chat.slice(0, -1).slice(-8);
    const messages = AI.buildMessages(ctx, history, msg, s);
    const raw = s.aiEngine === 'local'
      ? await WL.chatLocal(s.aiLocalModel, messages, (p) => { const b = document.getElementById('chatBox'); if (b && p && p.text) b.dataset.progress = p.text; })
      : await AI.chatCloud(s, messages);
    const { reply, actions } = AI.parseActions(raw);
    state.chat.push({ role: 'assistant', content: reply || '(no reply)' });
    if (actions.length) state.pendingActions = { actions, describe: AI.describeActions(actions, state) };
  } catch (e) {
    state.chat.push({ role: 'assistant', content: '⚠︎ ' + e.message });
  }
  state.aiBusy = false; render();
  setTimeout(() => { const b = document.getElementById('chatBox'); if (b) b.scrollTop = b.scrollHeight; }, 60);
}

async function approveActions() {
  const p = state.pendingActions; if (!p) return;
  const out = AI.applyActions(p.actions, state);
  await store.savePlan(out.plan); await store.saveSettings(out.settings);
  for (const w of out.wellnessUpserts) await store.putWellness(w);
  for (const j of out.journalAdds) await store.putJournalEntry(j);
  [state.settings, state.plan, state.wellness, state.journal] = await Promise.all([store.getSettings(), store.getPlan(), store.getAllWellness(), store.getAllJournal()]);
  state.pendingActions = null; recompute(); render();
  toast(`Applied: ${out.summary.join('; ') || 'changes'}.`, 'ok');
}

function addJournalPrompt() {
  const { back, modal } = openModal(`<h3>New journal note</h3><textarea id="jn_text" rows="4" placeholder="How did it go? How do you feel?"></textarea><div class="card-actions" style="margin-top:12px"><button class="btn primary" id="jn_save">Save</button><button class="btn ghost" id="jn_cancel">Cancel</button></div>`);
  modal.querySelector('#jn_cancel').onclick = () => back.remove();
  modal.querySelector('#jn_save').onclick = async () => {
    const t = modal.querySelector('#jn_text').value.trim(); if (!t) { back.remove(); return; }
    await store.putJournalEntry({ id: 'j' + Date.now().toString(36), date: M.dayKey(new Date()), text: t, tags: [], source: 'user' });
    state.journal = await store.getAllJournal(); back.remove(); render(); toast('Note saved.', 'ok');
  };
}

async function acceptAdapt() {
  const changes = window.__adapt || [];
  if (!changes.length) { toast('Nothing to adapt.'); return; }
  state.plan = A.applyAdaptation(state.plan, changes);
  await store.savePlan(state.plan); recompute(); render();
  toast(`Applied ${changes.length} adjustment(s).`, 'ok');
}
async function toggleAutoAdapt(on) {
  state.settings = { ...state.settings, autoAdaptApply: on };
  await store.saveSettings(state.settings);
  if (on) await applyPendingAdapt();
  render();
}
async function applyPendingAdapt() {
  if (!state.settings.autoAdaptApply) return;
  const signals = A.fatigueSignals(state.pmc);
  const adapt = A.adaptationSuggestions(state.plan, signals, state.settings, todayWellness());
  if (adapt.changes.length) {
    state.plan = A.applyAdaptation(state.plan, adapt.changes);
    await store.savePlan(state.plan); recompute();
    toast(`Auto-adjusted ${adapt.changes.length} session(s).`, 'ok');
  }
}
async function genTaper() {
  const taper = PL.generateTaper(state.settings, state.pmc);
  if (!taper || !taper.sessions.length) { toast('Set a race date in Setup first.', 'err'); return; }
  state.plan = PL.applyTaper(state.plan, taper);
  await store.savePlan(state.plan); recompute(); render();
  toast(`Taper added — ${taper.summary.length} weeks to race day.`, 'ok');
}
async function fetchStravaStreamsForRecent() {
  const token = state.settings.stravaAccessToken;
  if (!token) { toast('Add a Strava token in Setup first.', 'err'); state.tab = 'setup'; render(); return; }
  const targets = state.activities.filter(a => a.source === 'strava' && a.stravaId && !a.enriched)
    .sort((x, y) => y.startTime.localeCompare(x.startTime)).slice(0, 15);
  if (!targets.length) { toast('Strava activities already enriched.'); return; }
  toast(`Enriching ${targets.length} from Strava…`);
  let done = 0;
  for (const a of targets) {
    try {
      const upd = { ...a };
      const detail = await fetchStravaDetail(token, a.stravaId).catch(() => null);
      if (detail) { if (detail.perceivedExertion != null) upd.rpe = detail.perceivedExertion; upd.description = detail.description; upd.privateNote = detail.privateNote; upd.relativeEffort = detail.relativeEffort; if (detail.calories) upd.calories = detail.calories; upd.gear = detail.gear; }
      const m = await fetchStravaStreams(token, a.stravaId, a.sport).catch(() => null);
      if (m) { upd.best = m.best; upd.decoupling = m.decoupling; upd.gapBest = m.gapBest; }
      upd.enriched = true;
      await store.updateActivity(upd); done++;
    } catch (e) { toast(e.message, 'err'); break; }
  }
  state.activities = await store.getAllActivities(); recompute(); render();
  toast(`Enriched ${done} activities (effort, notes, streams).`, 'ok');
}

function openWorkoutModal(session) {
  const wk = generateWorkoutFromSession(session, state.est?.lthr?.value, state.settings);
  const text = workoutToText(wk);
  const html = `<h3>Garmin workout</h3>
    <p class="field-note" style="margin-top:0">Generated from “${escapeHtml(session.title || cap(session.sport))}”. Import the .fit in Garmin Connect → Training → Workouts → Import (beta — check your first import). Tweak the session title/duration to reshape it.</p>
    <pre class="export">${escapeHtml(text)}</pre>
    <div class="card-actions"><button class="btn primary" id="wk_fit">Download .fit</button><button class="btn" id="wk_txt">Download .txt</button><button class="btn ghost" id="wk_json">Copy JSON</button><button class="btn ghost" id="wk_close">Close</button></div>`;
  const { back, modal } = openModal(html);
  const fname = wk.name.replace(/[^a-z0-9]+/gi, '_');
  modal.querySelector('#wk_close').onclick = () => back.remove();
  modal.querySelector('#wk_fit').onclick = () => { downloadBytes(`${fname}.fit`, buildWorkoutFit(wk)); toast('Workout .fit downloaded.', 'ok'); };
  modal.querySelector('#wk_txt').onclick = () => download(`${fname}.txt`, text);
  modal.querySelector('#wk_json').onclick = () => copyText(JSON.stringify(wk, null, 2), 'Workout JSON copied.');
}
function downloadBytes(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

async function saveWeight() {
  const date = val('w_date') || M.dayKey(new Date());
  const kg = parseFloat(val('w_kg'));
  if (!Number.isFinite(kg) || kg <= 0) { toast('Enter a weight.', 'err'); return; }
  await store.putWeight(date, kg);
  state.weights = await store.getAllWeights();
  recompute(); render();
  toast(`Logged ${kg} ${state.settings.weightUnit} for ${date}.`, 'ok');
}

async function acceptEstimate(field, value) {
  const s = { ...state.settings };
  s[field] = value;
  s.sources = { ...(s.sources || {}), [field]: 'estimated' };
  state.settings = s;
  await store.saveSettings(s);
  recompute(); render();
  toast(`${field} set to the estimated value.`, 'ok');
}

async function acceptCalibration(t1, t2) {
  const s = { ...state.settings, ctlDays: t1, atlDays: t2 };
  state.settings = s;
  await store.saveSettings(s);
  recompute(); render();
  toast(`Model constants updated to best fit (τ ${t1}/${t2}).`, 'ok');
}

function openTestModal() {
  const today = M.dayKey(new Date());
  const html = `<h3>Add benchmark test</h3>
    <label>Type</label>
    <select id="t_type">
      <option value="swim_css">Swim CSS (400m + 200m TT)</option>
      <option value="run_tt20">20-min run time trial</option>
      <option value="bike_tt20">20-min bike time trial</option>
      <option value="swim_tt">Swim time trial (single)</option>
    </select>
    <label>Date</label><input id="t_date" type="date" value="${today}">
    <div id="t_fields"></div>
    <div class="card-actions" style="margin-top:16px"><button class="btn primary" id="t_save">Save test</button><button class="btn ghost" id="t_cancel">Cancel</button></div>`;
  const { back, modal } = openModal(html);
  const fields = modal.querySelector('#t_fields');
  const typeSel = modal.querySelector('#t_type');
  const renderFields = () => {
    const ty = typeSel.value;
    if (ty === 'swim_css') fields.innerHTML = `<div class="row"><div><label>400m time (m:ss)</label><input id="t_t400" placeholder="6:20"></div><div><label>200m time (m:ss)</label><input id="t_t200" placeholder="3:05"></div></div>`;
    else if (ty === 'run_tt20') fields.innerHTML = `<div class="row"><div><label>Distance in 20 min (m)</label><input id="t_dist" type="number" placeholder="4600"></div><div><label>Avg HR (opt.)</label><input id="t_hr" type="number" placeholder="176"></div></div>`;
    else if (ty === 'bike_tt20') fields.innerHTML = `<div class="row"><div><label>Avg speed (km/h)</label><input id="t_kmh" type="number" step="0.1" placeholder="34"></div><div><label>Avg HR (opt.)</label><input id="t_hr" type="number" placeholder="172"></div></div>`;
    else fields.innerHTML = `<div class="row"><div><label>Distance (m)</label><input id="t_dist" type="number" placeholder="1000"></div><div><label>Time (m:ss)</label><input id="t_time" placeholder="16:40"></div></div>`;
  };
  renderFields();
  typeSel.onchange = renderFields;
  modal.querySelector('#t_cancel').onclick = () => back.remove();
  modal.querySelector('#t_save').onclick = async () => {
    const ty = typeSel.value;
    const test = { id: 'T' + Date.now().toString(36), type: ty, date: modal.querySelector('#t_date').value };
    try {
      if (ty === 'swim_css') { test.t400 = clockToSec(gv('t_t400')); test.t200 = clockToSec(gv('t_t200')); if (!(test.t400 > test.t200)) throw new Error('400m time must be greater than 200m time.'); }
      else if (ty === 'run_tt20') { test.distanceM = parseFloat(gv('t_dist')); test.avgHr = intOrNull(gv('t_hr')); if (!test.distanceM) throw new Error('Enter the distance.'); }
      else if (ty === 'bike_tt20') { const k = parseFloat(gv('t_kmh')); test.avgSpeed = k ? k / 3.6 : null; test.avgHr = intOrNull(gv('t_hr')); if (!test.avgSpeed) throw new Error('Enter the avg speed.'); }
      else { test.distanceM = parseFloat(gv('t_dist')); test.timeSec = clockToSec(gv('t_time')); if (!test.distanceM || !test.timeSec) throw new Error('Enter distance and time.'); }
    } catch (e) { toast(e.message, 'err'); return; }
    await store.putTest(test);
    state.tests = await store.getAllTests();
    recompute(); back.remove(); render();
    toast('Test saved — thresholds updated.', 'ok');
  };
  function gv(id) { return modal.querySelector('#' + id)?.value ?? ''; }
}

// ---- actions impl -----------------------------------------------------------

async function onFilesChosen(e) {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  let all = [];
  const errs = [];
  for (const f of files) {
    try { all = all.concat(await parseFile(f)); }
    catch (err) { errs.push(`${f.name}: ${err.message}`); }
  }
  if (all.length) {
    const { added, updated } = await store.putActivities(all);
    state.activities = await store.getAllActivities();
    recompute(); render();
    toast(`Imported ${added} new, ${updated} updated${errs.length ? `; ${errs.length} failed` : ''}.`, 'ok');
  }
  if (errs.length && !all.length) toast(errs[0], 'err');
}

async function onBackupChosen(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const obj = JSON.parse(await f.text());
  const replace = confirm('Replace all current data with this backup? Cancel = merge.');
  await store.importBackup(obj, replace ? 'replace' : 'merge');
  [state.settings, state.activities, state.plan] = await Promise.all([store.getSettings(), store.getAllActivities(), store.getPlan()]);
  recompute(); render();
  toast('Backup imported.', 'ok');
}

async function genPlan() {
  const hours = parseFloat(document.getElementById('planHours').value) || 8;
  const weeks = parseInt(document.getElementById('planWeeks').value) || 12;
  state.plan = PL.generateBase(state.settings, { weeklyHours: hours, weeks });
  await store.savePlan(state.plan);
  recompute(); render();
  toast(`Seeded a ${weeks}-week base block — edit anything.`, 'ok');
}

async function onPlanEdit(id, field, value) {
  const s = state.plan.sessions.find(x => x.id === id); if (!s) return;
  if (field === 'title') s.title = value;
  else if (field === 'sport') s.sport = value;
  else if (field === 'min') { s.targetDurationSec = Math.max(0, (parseFloat(value) || 0) * 60); s.targetLoad = Math.round(M.trimp(s.targetDurationSec / 60, s.targetReserve ?? 0.65, state.settings)); }
  clearTimeout(window.__planSave);
  window.__planSave = setTimeout(async () => { await store.savePlan(state.plan); recompute();
    // light refresh of projection + week totals without losing focus: only if on plan tab
  }, 400);
}

async function savePlanRecompute() { await store.savePlan(state.plan); recompute(); render(); }

async function saveSettings() {
  const s = { ...state.settings };
  s.raceName = val('s_raceName'); s.raceDate = val('s_raceDate');
  s.maxHr = numv('s_maxHr'); s.restHr = numv('s_restHr');
  const css = clockToSec(val('s_css')); s.cssSpeed = css ? 100 / css : s.cssSpeed;
  const run = clockToSec(val('s_run')); s.runThresholdSpeed = run ? 1000 / run : s.runThresholdSpeed;
  s.ctlDays = numv('s_ctl') || 42; s.atlDays = numv('s_atl') || 7; s.trimpB = parseFloat(val('s_b')) || 1.92;
  s.tsbDeepFatigue = numv('s_deep'); s.tsbVeryFresh = numv('s_fresh'); s.rampWarn = numv('s_ramp');
  s.age = intOrNull(val('s_age')); s.weightUnit = val('s_wunit') || 'kg';
  s.defaultWeightKg = parseFloat(val('s_dweight')) || 75; s.loadBasis = val('s_basis') || 'trimp';
  s.energyBlend = clamp01((parseFloat(val('s_blend')) || 50) / 100);
  s.imSwimFactor = parseFloat(val('s_imswim')) || 1.06; s.imBikeTargetKmh = parseFloat(val('s_imbike')) || 0;
  s.imRunFactor = parseFloat(val('s_imrun')) || 1.10; s.transitionsMin = numv('s_trans') || 8;
  s.weightEconomyPct = parseFloat(val('s_econ')) || 1.0;
  s.autoAdaptApply = document.getElementById('s_autoadapt')?.checked || false;
  s.acwrHigh = parseFloat(val('s_acwrhi')) || 1.5; s.monotonyHigh = parseFloat(val('s_mono')) || 2.5;
  s.adaptCutPct = clamp01((parseFloat(val('s_cut')) || 60) / 100); s.taperWeeks = numv('s_taper') || 3;
  s.testIntervalWeeks = numv('s_testiv') || 6;
  s.fuelCarbsPerHr = numv('s_carbs') || 80; s.fuelFluidMlPerHr = numv('s_fluid') || 600; s.fuelSodiumMgPerHr = numv('s_sodium') || 700;
  s.aiEngine = val('s_aiengine') || 'cloud'; s.aiBaseUrl = val('s_aibase').trim(); s.aiModel = val('s_aimodel').trim();
  s.aiApiKey = val('s_aikey').trim(); s.aiLocalModel = val('s_ailocal').trim() || s.aiLocalModel;
  s.aiSubjectiveWeight = Number.isFinite(parseFloat(val('s_subj'))) ? parseFloat(val('s_subj')) : 1;
  const scopeEls = document.querySelectorAll('#aiScopes [data-scope]');
  if (scopeEls.length) { const sc = {}; scopeEls.forEach(el => sc[el.dataset.scope] = el.getAttribute('aria-pressed') === 'true'); s.aiScopes = sc; }
  s.stravaAccessToken = val('s_strava').trim();
  state.settings = s;
  await store.saveSettings(s);
  recompute(); render();
  toast('Settings saved — model updated.', 'ok');
}

async function syncStrava() {
  const token = state.settings.stravaAccessToken;
  if (!token) { toast('Add a Strava access token in Setup first.', 'err'); state.tab = 'setup'; render(); return; }
  toast('Fetching from Strava…');
  const latest = state.activities.filter(a => a.source === 'strava').map(a => a.startTime).sort().slice(-1)[0];
  const after = latest ? Math.floor(new Date(latest).getTime() / 1000) : 0;
  const list = await fetchStravaActivities(token, after);
  if (!list.length) { toast('No new Strava activities.'); return; }
  const { added, updated } = await store.putActivities(list);
  state.activities = await store.getAllActivities();
  recompute(); render();
  toast(`Strava: ${added} new, ${updated} updated.`, 'ok');
}

async function backupExport() {
  const data = await store.exportBackup();
  download(`ironpath-backup-${M.dayKey(new Date())}.json`, JSON.stringify(data, null, 2));
  toast('Backup downloaded.', 'ok');
}

async function wipeData() {
  if (!confirm('Delete ALL sessions, plan and settings from this device? Export a backup first if unsure.')) return;
  for (const a of state.activities) await store.deleteActivity(a.id);
  await store.savePlan({ phases: [], sessions: [] });
  state.activities = []; state.plan = { phases: [], sessions: [] };
  recompute(); render();
  toast('All data deleted.', 'ok');
}

// ---- session modal (add / edit) --------------------------------------------

function openSessionModal(a) {
  const isNew = !a;
  const d = a ? new Date(a.startTime) : new Date();
  const dateStr = M.dayKey(d);
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const html = `
    <h3>${isNew ? 'Add session' : 'Edit session'}</h3>
    <div class="chips" id="mSport">${SPORTS.map(sp => `<span class="chip" data-sp="${sp}" aria-pressed="${(a?.sport || 'run') === sp}">${cap(sp)}</span>`).join('')}</div>
    <div class="row"><div><label>Date</label><input id="m_date" type="date" value="${dateStr}"></div><div><label>Start</label><input id="m_time" type="time" value="${timeStr}"></div></div>
    <label>Title (optional)</label><input id="m_title" value="${escapeAttr(a?.name || '')}" placeholder="e.g. Brick: bike + run">
    <div class="row"><div><label>Duration (min)</label><input id="m_min" type="number" min="0" step="1" value="${a ? Math.round((a.durationSec||0)/60) : 60}"></div>
      <div><label>Distance (km)</label><input id="m_dist" type="number" min="0" step="0.01" value="${a?.distanceM ? (a.distanceM/1000).toFixed(2) : ''}"></div></div>
    <div class="row-3"><div><label>Avg HR</label><input id="m_hr" type="number" value="${a?.avgHr || ''}"></div>
      <div><label>Max HR</label><input id="m_maxhr" type="number" value="${a?.maxHr || ''}"></div>
      <div><label>RPE (1-10)</label><input id="m_rpe" type="number" min="1" max="10" value="${a?.rpe ?? ''}"></div></div>
    <label>Notes</label><textarea id="m_notes">${escapeHtml(a?.notes || '')}</textarea>
    <div class="card-actions" style="margin-top:16px">
      <button class="btn primary" id="m_save">${isNew ? 'Add' : 'Save'}</button>
      <button class="btn ghost" id="m_cancel">Cancel</button>
      ${isNew ? '' : '<button class="btn danger" id="m_del">Delete</button>'}
    </div>`;
  const { back, modal } = openModal(html);
  let sport = a?.sport || 'run';
  modal.querySelector('#mSport').addEventListener('click', ev => {
    const c = ev.target.closest('[data-sp]'); if (!c) return;
    sport = c.dataset.sp;
    modal.querySelectorAll('[data-sp]').forEach(x => x.setAttribute('aria-pressed', x.dataset.sp === sport));
  });
  modal.querySelector('#m_cancel').onclick = () => back.remove();
  if (!isNew) modal.querySelector('#m_del').onclick = async () => {
    if (!confirm('Delete this session?')) return;
    await store.deleteActivity(a.id); state.activities = await store.getAllActivities();
    recompute(); back.remove(); render(); toast('Session deleted.', 'ok');
  };
  modal.querySelector('#m_save').onclick = async () => {
    const date = modal.querySelector('#m_date').value;
    const time = modal.querySelector('#m_time').value || '09:00';
    const startTime = new Date(`${date}T${time}`).toISOString();
    const min = parseFloat(modal.querySelector('#m_min').value) || 0;
    const distKm = parseFloat(modal.querySelector('#m_dist').value);
    const rec = {
      id: a?.id || ('m' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)),
      source: a?.source || 'manual', sport,
      name: modal.querySelector('#m_title').value.trim(),
      startTime, durationSec: min * 60,
      distanceM: Number.isFinite(distKm) ? distKm * 1000 : (a?.distanceM ?? null),
      avgHr: intOrNull(modal.querySelector('#m_hr').value),
      maxHr: intOrNull(modal.querySelector('#m_maxhr').value),
      rpe: intOrNull(modal.querySelector('#m_rpe').value),
      elevationGainM: a?.elevationGainM ?? null,
      calories: a?.calories ?? null,
      notes: modal.querySelector('#m_notes').value,
    };
    if (rec.distanceM && rec.durationSec) rec.avgSpeed = rec.distanceM / rec.durationSec;
    await store.updateActivity(rec);
    state.activities = await store.getAllActivities();
    recompute(); back.remove(); render();
    toast(isNew ? 'Session added.' : 'Session saved.', 'ok');
  };
}

function openModal(html) {
  const back = document.createElement('div'); back.className = 'modal-back';
  const modal = document.createElement('div'); modal.className = 'modal'; modal.innerHTML = html;
  back.appendChild(modal); document.body.appendChild(back);
  back.addEventListener('click', e => { if (e.target === back) back.remove(); });
  return { back, modal };
}

// ---- formatting + tiny helpers ---------------------------------------------

function fmtDur(sec) { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}m`; }
function fmtDist(a) { if (a.sport === 'swim') return `${Math.round(a.distanceM)} m`; return `${(a.distanceM / 1000).toFixed(a.distanceM < 10000 ? 2 : 1)} km`; }
function paceStr(a) {
  if (!a.avgSpeed && a.distanceM && a.durationSec) a = { ...a, avgSpeed: a.distanceM / a.durationSec };
  if (!a.avgSpeed) return '';
  if (a.sport === 'swim') return `${secToClock(100 / a.avgSpeed)}/100m`;
  if (a.sport === 'bike') return `${(a.avgSpeed * 3.6).toFixed(1)} km/h`;
  if (a.sport === 'run') return `${secToClock(1000 / a.avgSpeed)}/km`;
  return '';
}
function fmtDate(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); }
function monthLabel(ym) { const [y, m] = ym.split('-'); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
function weekdayShort(dstr) { return new Date(dstr).toLocaleDateString(undefined, { weekday: 'short' }); }
function secToClock(sec) { sec = Math.round(sec || 0); if (!sec) return ''; const m = Math.floor(sec / 60); const s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function clockPace(sec) { return secToClock(sec); }
function hms(sec) { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }
function clockToSec(str) { if (!str) return 0; const p = str.split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : parseFloat(str) || 0; }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function val(id) { return document.getElementById(id)?.value ?? ''; }
function numv(id) { return parseFloat(val(id)) || 0; }
function intOrNull(v) { const n = parseInt(v); return Number.isFinite(n) ? n : null; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function basisLabel(s) {
  if (s.loadBasis === 'energy') return { name: 'Energy', sub: 'weight-driven' };
  if (s.loadBasis === 'combined') return { name: 'Combined', sub: `${Math.round((s.energyBlend ?? 0.5) * 100)}% energy` };
  return { name: 'TRIMP', sub: 'HR strain' };
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(window.__toast); window.__toast = setTimeout(() => { t.hidden = true; }, 3200);
}
async function copyText(text, ok) {
  try { await navigator.clipboard.writeText(text); toast(ok, 'ok'); }
  catch { download('ironpath-prompt.txt', text); toast('Clipboard blocked — downloaded instead.', 'ok'); }
}
function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}
