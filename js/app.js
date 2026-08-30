// app.js — IronPath UI controller. Ties the store, model, parsers, charts and
// exports together into the tabbed PWA.

import * as store from './store.js';
import * as M from './model.js';
import * as charts from './charts.js';
import { parseFile } from './parsers.js';
import { fetchStravaActivities } from './strava.js';
import * as PL from './plan.js';
import { buildAiPayload, buildPrompt } from './aiexport.js';

const SPORTS = ['swim', 'bike', 'run', 'strength', 'other'];
const SPORT_COLORS = {
  swim: getVar('--swim'), bike: getVar('--bike'), run: getVar('--run'),
  strength: getVar('--strength'), other: getVar('--other'),
};
function getVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888'; }

const state = { settings: null, activities: [], plan: null, pmc: [], tab: 'home' };

// ---- boot -------------------------------------------------------------------

init();
async function init() {
  try {
    [state.settings, state.activities, state.plan] = await Promise.all([
      store.getSettings(), store.getAllActivities(), store.getPlan(),
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
}

function recompute() {
  const plannedDaily = M.plannedDailyLoads(state.plan, state.settings);
  const hasFuture = [...plannedDaily.keys()].some(d => d > M.dayKey(new Date()));
  state.pmc = M.performanceChart(state.activities, state.settings, {
    plannedDaily,
    end: hasFuture ? [...plannedDaily.keys()].sort().slice(-1)[0] : M.dayKey(new Date()),
  });
}

function wireChrome() {
  document.getElementById('tabbar').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    state.tab = b.dataset.tab; render();
  });
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
  const view = document.getElementById('view');
  const map = { home: renderHome, log: renderLog, plan: renderPlan, stats: renderStats, ai: renderAi, setup: renderSetup };
  view.innerHTML = (map[state.tab] || renderHome)();
  view.scrollTop = 0; window.scrollTo(0, 0);
  bindView();
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
      <button class="btn ghost" data-action="goto" data-tab="ai">AI coach export</button>
    </div>
    <p class="field-note">Import a .fit, .tcx or .gpx from Garmin or Strava, or log a session by hand. Everything stays on your device.</p>
  </div>`;

  return `<h2 class="page-title">Dashboard</h2>
    ${tiles}
    <div class="dash-2"><div>${chart}</div><div>${sugCards}${recentCard}</div></div>
    ${quick}`;
}

function sessRow(a) {
  const { load } = M.activityLoad(a, state.settings);
  return `<div class="sess" data-id="${a.id}" data-action="openSess">
    <span class="dot" style="background:${SPORT_COLORS[a.sport]}"></span>
    <div class="meta"><div class="t">${a.name || cap(a.sport)} <span class="pill">${a.sport}</span></div>
      <div class="d">${fmtDate(a.startTime)} · ${fmtDur(a.durationSec)}${a.distanceM ? ' · ' + fmtDist(a) : ''}${a.avgHr ? ' · ' + a.avgHr + ' bpm' : ''}${paceStr(a) ? ' · ' + paceStr(a) : ''}</div></div>
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
    </div><p class="field-note">FIT and TCX carry full summaries (sport, HR, distance). GPX has no sport tag, so set it after import if needed.</p></div>
    ${list}`;
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
    ${proj}
    ${weekCards}`;
}

function planRow(s) {
  return `<div class="psess" data-id="${s.id}">
    <div class="pd">${weekdayShort(s.date)}<br>${s.date.slice(8)}</div>
    <div><input class="title-in" data-pf="title" value="${escapeAttr(s.title)}" placeholder="${cap(s.sport)} session"></div>
    <select data-pf="sport" style="width:92px">${SPORTS.map(sp => `<option ${sp === s.sport ? 'selected' : ''}>${sp}</option>`).join('')}</select>
    <div style="display:flex;gap:6px;align-items:center">
      <input data-pf="min" type="number" min="0" step="5" value="${Math.round((s.targetDurationSec || 0) / 60)}" style="width:64px" title="minutes">
      <span class="muted" style="font-size:12px;width:44px;text-align:right">${s.targetLoad || 0}</span>
      <button class="btn sm ghost" data-action="delPlanSess" title="delete">✕</button>
    </div>
  </div>`;
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
    <div class="card"><h3>Time by sport — last 6 weeks</h3>${charts.loadBySportChart(Object.fromEntries(Object.entries(bySportSecs).map(([k,v])=>[k,v/3600])), SPORT_COLORS)}</div>`;
}

// ---- AI ---------------------------------------------------------------------

function renderAi() {
  const payload = buildAiPayload(state.activities, state.settings, state.plan);
  const prompt = buildPrompt(payload);
  const preview = JSON.stringify(payload, null, 2);
  window.__ai = { payload, prompt, preview };
  const n = payload.sessions.length;
  return `<h2 class="page-title">AI coach export</h2>
    <div class="card"><div class="hint">This is the piece the big apps don't give you: a clean, structured snapshot of your training you can hand to an AI. Copy the prompt + data below into Claude and ask for recommendations grounded in your actual numbers.</div>
      <div class="card-actions" style="margin-top:14px">
        <button class="btn primary" data-action="copyPrompt">Copy prompt + data</button>
        <button class="btn" data-action="copyJson">Copy JSON only</button>
        <button class="btn ghost" data-action="dlJson">Download JSON</button>
      </div>
      <p class="field-note">${n} sessions · ${payload.dailyModelSeries.length} days of model history included.</p>
    </div>
    <div class="card"><h3>The prompt</h3><pre class="export">${escapeHtml(prompt.split('```json')[0].trim())}\n\n[ …followed by your ${(preview.length/1024).toFixed(0)} KB JSON export… ]</pre></div>
    <div class="card"><h3>Data preview</h3><pre class="export">${escapeHtml(preview.slice(0, 2400))}${preview.length > 2400 ? '\n…' : ''}</pre></div>`;
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
      <p class="field-note">${state.activities.length} sessions stored locally. The backup is a full copy you own — settings, plan and every session.</p>
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
    const pf = e.target.dataset.pf; if (!pf) return;
    const row = e.target.closest('.psess'); const id = row?.dataset.id;
    onPlanEdit(id, pf, e.target.value);
  };
}

const ACTIONS = {
  import: () => document.getElementById('fileInput').click(),
  goto: (t) => { state.tab = t.dataset.tab; render(); },
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
};

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
function clockToSec(str) { if (!str) return 0; const p = str.split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : parseFloat(str) || 0; }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function val(id) { return document.getElementById(id)?.value ?? ''; }
function numv(id) { return parseFloat(val(id)) || 0; }
function intOrNull(v) { const n = parseInt(v); return Number.isFinite(n) ? n : null; }
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
