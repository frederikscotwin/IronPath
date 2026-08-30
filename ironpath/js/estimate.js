// estimate.js — the "learn me from my data" engine.
// -----------------------------------------------------------------------------
// Three jobs, all transparent and all suggestions you approve:
//   1. estimateThresholds() — infer max/threshold HR, CSS, run-threshold pace and
//      zones from training history, anchored by any benchmark tests you log.
//   2. calibrateModel()     — fit the impulse-response time constants and the
//      fitness/fatigue gains to a performance proxy built from your own sessions.
//   3. predict()            — turn all of that into threshold trends, today's
//      predicted efforts, an Ironman finish projection, and a readiness score.
// Nothing here is auto-applied; the UI shows each result with an Accept button.
// -----------------------------------------------------------------------------

import {
  clamp, dayKey, addDays, dayRange, hrReserve, dailyLoads, weightTrend, basisScale, resolveLoad,
} from './model.js';

// ---- small stats ------------------------------------------------------------

function percentile(arr, p) {
  const a = [...arr].filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = clamp((p / 100) * (a.length - 1), 0, a.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); }
function conf(n, hi, mid) { return n >= hi ? 'high' : n >= mid ? 'med' : 'low'; }

// pace helpers
export function mpsToPerKm(mps) { return mps ? 1000 / mps : null; }
export function mpsToPer100(mps) { return mps ? 100 / mps : null; }
function clock(sec) { if (!sec || !Number.isFinite(sec)) return '—'; const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

// ---- 1. threshold + zone estimation ----------------------------------------

export function estimateThresholds(activities, tests, settings) {
  const withHr = activities.filter(a => a.avgHr);
  const maxHrs = activities.map(a => a.maxHr).filter(Boolean);
  const avgHrs = withHr.map(a => a.avgHr);
  // Best-effort values across sessions: best(sport|null, '20', 'speed'|'hr').
  const best = (sport, dur, key) => activities
    .filter(a => (sport ? a.sport === sport : true))
    .map(a => a.best?.dur?.[dur]?.[key])
    .filter(Number.isFinite);

  // Max HR: highest reliably-seen maximum (guard a single bad spike with p99).
  let maxHr = null, maxHrConf = 'low', maxHrN = 0;
  if (maxHrs.length) {
    const top = Math.max(...maxHrs);
    const p99 = percentile(maxHrs, 99);
    maxHr = Math.round(Math.min(top, (p99 || top) + 2));
    maxHrN = maxHrs.filter(h => h >= maxHr - 5).length;
    maxHrConf = conf(maxHrN, 5, 2);
  } else if (avgHrs.length) {
    maxHr = Math.round(Math.max(...avgHrs) / 0.92); maxHrConf = 'low';
  }

  // Resting HR: training files rarely contain it — estimate a conservative floor.
  let restHr = null, restHrConf = 'low';
  if (avgHrs.length) { restHr = Math.round(clamp((percentile(avgHrs, 5) || 120) - 25, 35, 65)); }

  // Threshold HR (LTHR): test  >  best sustained 20-min HR (stream)  >  high
  // percentile of hard session-average HR. Bounded by maxHr.
  let lthr = null, lthrConf = 'low', lthrN = 0, lthrSrc = 'history';
  const hard = withHr.filter(a => (a.durationSec || 0) >= 20 * 60);
  const ttHr = tests.filter(t => t.avgHr && (t.type === 'run_tt20' || t.type === 'bike_tt20')).map(t => t.avgHr);
  const b20hr = best(null, '20', 'hr');
  if (ttHr.length) { lthr = Math.round(Math.max(...ttHr)); lthrConf = 'high'; lthrN = ttHr.length; lthrSrc = 'test'; }
  else if (b20hr.length) {
    lthr = Math.round(Math.max(...b20hr));
    if (maxHr) lthr = Math.round(clamp(lthr, 0.80 * maxHr, 0.97 * maxHr));
    lthrN = b20hr.length; lthrConf = conf(lthrN, 3, 1); lthrSrc = '20-min effort';
  } else if (hard.length) {
    let p = percentile(hard.map(a => a.avgHr), 90);
    if (maxHr) p = clamp(p, 0.80 * maxHr, 0.95 * maxHr);
    lthr = Math.round(p); lthrN = hard.length; lthrConf = conf(lthrN, 8, 3);
  }

  // Critical Swim Speed (m/s): test > best 20/10-min swim (stream) > best avg swim.
  let cssSpeed = null, cssConf = 'low', cssN = 0, cssSource = 'history';
  const cssTest = tests.filter(t => t.type === 'swim_css' && t.t400 && t.t200).slice(-1)[0];
  const swimTt = tests.filter(t => t.type === 'swim_tt' && t.distanceM && t.timeSec).slice(-1)[0];
  const b20swim = best('swim', '20', 'speed').concat(best('swim', '10', 'speed'));
  if (cssTest) { cssSpeed = 200 / (cssTest.t400 - cssTest.t200); cssConf = 'high'; cssSource = 'test'; cssN = 1; }
  else if (swimTt) { cssSpeed = (swimTt.distanceM / swimTt.timeSec) * 0.96; cssConf = 'med'; cssSource = 'test'; cssN = 1; }
  else if (b20swim.length) { cssSpeed = Math.max(...b20swim) * 0.99; cssN = b20swim.length; cssConf = conf(cssN, 3, 1); cssSource = '20-min effort'; }
  else {
    const swims = activities.filter(a => a.sport === 'swim' && a.avgSpeed && (a.distanceM || 0) >= 300 && (a.durationSec || 0) >= 8 * 60);
    if (swims.length) { cssSpeed = Math.max(...swims.map(a => a.avgSpeed)) * 0.97; cssN = swims.length; cssConf = conf(cssN, 6, 2); }
  }

  // Run threshold speed (m/s): test > best 20-min run (stream) > best avg run.
  let runThresholdSpeed = null, runConf = 'low', runN = 0, runSource = 'history';
  const runTt = tests.filter(t => t.type === 'run_tt20' && t.distanceM).slice(-1)[0];
  // Prefer the grade-adjusted best-20 where we have elevation (fairer on hills).
  const b20run = activities.filter(a => a.sport === 'run')
    .map(a => a.gapBest?.dur?.['20']?.speed ?? a.best?.dur?.['20']?.speed)
    .filter(Number.isFinite);
  if (runTt) { runThresholdSpeed = runTt.distanceM / 1200; runConf = 'high'; runSource = 'test'; runN = 1; }
  else if (b20run.length) { runThresholdSpeed = Math.max(...b20run) * 0.96; runN = b20run.length; runConf = conf(runN, 3, 1); runSource = '20-min effort'; }
  else {
    const runs = activities.filter(a => a.sport === 'run' && a.avgSpeed && (a.durationSec || 0) >= 15 * 60 && (a.durationSec || 0) <= 45 * 60);
    if (runs.length) { runThresholdSpeed = Math.max(...runs.map(a => a.avgSpeed)) * 0.97; runN = runs.length; runConf = conf(runN, 6, 2); }
  }

  const zones = computeZones({ maxHr, lthr, cssSpeed, runThresholdSpeed }, settings.zoneModel);
  return {
    maxHr: { value: maxHr, confidence: maxHrConf, n: maxHrN, source: 'history' },
    restHr: { value: restHr, confidence: restHrConf, source: 'history' },
    lthr: { value: lthr, confidence: lthrConf, n: lthrN, source: lthrSrc },
    cssSpeed: { value: cssSpeed, confidence: cssConf, n: cssN, source: cssSource },
    runThresholdSpeed: { value: runThresholdSpeed, confidence: runConf, n: runN, source: runSource },
    zones,
  };
}

export function computeZones(est, model = 'lthr') {
  const out = { hr: [], runPace: [], swimPace: [] };
  const lthr = est.lthr, maxHr = est.maxHr;
  if (model === 'lthr' && lthr) {
    const b = (lo, hi) => ({ lo: lo ? Math.round(lthr * lo) : null, hi: hi ? Math.round(lthr * hi) : null });
    out.hr = [
      { z: 'Z1 Recovery', ...b(0, 0.85) },
      { z: 'Z2 Aerobic', ...b(0.85, 0.89) },
      { z: 'Z3 Tempo', ...b(0.90, 0.94) },
      { z: 'Z4 Threshold', ...b(0.95, 0.99) },
      { z: 'Z5 VO2', ...b(1.00, null) },
    ];
  } else if (maxHr) {
    const b = (lo, hi) => ({ lo: lo ? Math.round(maxHr * lo) : null, hi: hi ? Math.round(maxHr * hi) : null });
    out.hr = [
      { z: 'Z1 Recovery', ...b(0, 0.68) },
      { z: 'Z2 Aerobic', ...b(0.68, 0.78) },
      { z: 'Z3 Tempo', ...b(0.78, 0.87) },
      { z: 'Z4 Threshold', ...b(0.87, 0.94) },
      { z: 'Z5 VO2', ...b(0.94, null) },
    ];
  }
  if (est.runThresholdSpeed) {
    const v = est.runThresholdSpeed;
    const p = (mult) => clock(1000 / (v * mult)); // faster mult => faster pace
    out.runPace = [
      { z: 'Easy', range: `${p(0.78)}–${p(0.85)} /km` },
      { z: 'Endurance', range: `${p(0.85)}–${p(0.92)} /km` },
      { z: 'Tempo', range: `${p(0.92)}–${p(0.98)} /km` },
      { z: 'Threshold', range: `~${p(1.0)} /km` },
      { z: 'Interval', range: `faster than ${p(1.05)} /km` },
    ];
  }
  if (est.cssSpeed) {
    const v = est.cssSpeed;
    const p = (mult) => clock(100 / (v * mult));
    out.swimPace = [
      { z: 'Easy', range: `${p(0.85)}–${p(0.92)} /100m` },
      { z: 'Aerobic', range: `${p(0.92)}–${p(0.97)} /100m` },
      { z: 'Threshold (CSS)', range: `~${p(1.0)} /100m` },
      { z: 'Speed', range: `faster than ${p(1.05)} /100m` },
    ];
  }
  return out;
}

// Mean-max curve: best sustained speed and HR at each duration, per sport,
// aggregated across all sessions (from the parsed streams).
export function bestEffortCurve(activities) {
  const durs = ['5', '10', '20', '30', '60'];
  const out = {};
  for (const sport of ['swim', 'bike', 'run']) {
    const row = {};
    for (const d of durs) {
      const sp = activities.filter(a => a.sport === sport).map(a => a.best?.dur?.[d]?.speed).filter(Number.isFinite);
      const hr = activities.filter(a => a.sport === sport).map(a => a.best?.dur?.[d]?.hr).filter(Number.isFinite);
      if (sp.length || hr.length) row[d] = { speed: sp.length ? Math.max(...sp) : null, hr: hr.length ? Math.max(...hr) : null };
    }
    if (Object.keys(row).length) out[sport] = row;
  }
  return out;
}

// Aerobic decoupling over time (durability): lower = your pace-to-HR holds up
// better over long sessions, which is exactly what an Ironman rewards.
export function durability(activities) {
  const pts = activities.filter(a => Number.isFinite(a.decoupling))
    .map(a => ({ day: dayKey(a.startTime), p: a.decoupling, sport: a.sport }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const recent = pts.slice(-8);
  const avg = recent.length ? recent.reduce((s, x) => s + x.p, 0) / recent.length : null;
  return { points: pts, avg, latest: pts.length ? pts[pts.length - 1].p : null, n: pts.length };
}

// ---- 2. self-calibration of the impulse-response model ----------------------

// Efficiency factor: speed per unit HR reserve on a steady aerobic session.
// Rises as aerobic fitness improves, so its trend is a performance proxy.
function efSessions(activities, settings, sport) {
  const out = [];
  for (const a of activities) {
    if (a.sport !== sport || !a.avgHr || !a.avgSpeed || (a.durationSec || 0) < 20 * 60) continue;
    const r = hrReserve(a.avgHr, settings);
    if (r == null || r < 0.45 || r > 0.90) continue;
    out.push({ day: dayKey(a.startTime), ef: a.avgSpeed / r });
  }
  return out;
}

// Build a combined, sport-normalized performance index time series.
export function performanceProxy(activities, settings) {
  const perDay = new Map(); // day -> list of z values across sports
  for (const sport of ['swim', 'bike', 'run']) {
    const s = efSessions(activities, settings, sport);
    if (s.length < 4) continue;
    const efs = s.map(x => x.ef);
    const m = mean(efs), sd = std(efs) || 1;
    for (const x of s) {
      const z = (x.ef - m) / sd;
      if (!perDay.has(x.day)) perDay.set(x.day, []);
      perDay.get(x.day).push(z);
    }
  }
  return [...perDay.entries()]
    .map(([day, zs]) => ({ day, p: mean(zs) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function ewmaSeries(loadArr, tau) {
  const k = 1 - Math.exp(-1 / tau);
  const out = new Array(loadArr.length);
  let v = 0;
  for (let i = 0; i < loadArr.length; i++) { v = v + (loadArr[i] - v) * k; out[i] = v; }
  return out;
}

// Solve 3x3 linear system Ax=b (Gaussian elimination, partial pivot).
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

// OLS of y on [1, ctl, -atl]; returns coefficients and R².
function fitLinear(rows, y) {
  const n = rows.length;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = rows[i];
    for (let r = 0; r < 3; r++) {
      bb[r] += x[r] * y[i];
      for (let c = 0; c < 3; c++) A[r][c] += x[r] * x[c];
    }
  }
  const coef = solve3(A, bb);
  if (!coef) return null;
  const ym = mean(y);
  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const pred = coef[0] * rows[i][0] + coef[1] * rows[i][1] + coef[2] * rows[i][2];
    ssr += (y[i] - pred) ** 2; sst += (y[i] - ym) ** 2;
  }
  return { coef, r2: sst > 0 ? 1 - ssr / sst : 0 };
}

// Grid-search the fitness/fatigue time constants; at each grid point the gains
// are the least-squares fit. Best valid (positive-gain) fit wins.
export function calibrateModel(activities, settings, weights) {
  const proxy = performanceProxy(activities, settings);
  if (proxy.length < 10) return { ok: false, reason: `Need ~10+ steady HR sessions to fit (have ${proxy.length}). Log more, or add benchmark tests.`, n: proxy.length };

  const daily = dailyLoads(activities, settings, weights);
  const basis = settings.loadBasis || 'trimp';
  const blend = settings.energyBlend ?? 0.5;
  const scale = basisScale(daily, basis);
  const days = [...daily.keys()].sort();
  const start = days[0], end = dayKey(new Date());
  const allDays = dayRange(start, end);
  const idx = new Map(allDays.map((d, i) => [d, i]));
  const loadArr = allDays.map(d => resolveLoad(daily.get(d), basis, blend, scale));

  const pts = proxy.filter(p => idx.has(p.day));
  if (pts.length < 10) return { ok: false, reason: 'Not enough overlap between performance signal and load history.', n: pts.length };
  const y = pts.map(p => p.p);

  let best = null;
  for (let t1 = 20; t1 <= 56; t1 += 4) {
    const ctl = ewmaSeries(loadArr, t1);
    for (let t2 = 4; t2 <= 16; t2 += 2) {
      const atl = ewmaSeries(loadArr, t2);
      const rows = pts.map(p => [1, ctl[idx.get(p.day)], -atl[idx.get(p.day)]]);
      const fit = fitLinear(rows, y);
      if (!fit) continue;
      const [a, k1, k2] = fit.coef;
      if (k1 < 0 || k2 < 0) continue; // keep physiologically sensible sign
      if (!best || fit.r2 > best.r2) best = { tau1: t1, tau2: t2, a, k1, k2, r2: fit.r2 };
    }
  }
  if (!best) return { ok: false, reason: 'No positive-gain fit found; the performance signal may be too noisy yet.', n: pts.length };
  return { ok: true, ...best, n: pts.length,
    quality: best.r2 >= 0.5 ? 'strong' : best.r2 >= 0.3 ? 'moderate' : 'weak' };
}

// ---- 3. performance prediction ---------------------------------------------

function riegel(t1, d1, d2, exp = 1.06) { return t1 * Math.pow(d2 / d1, exp); }

export function predict(activities, settings, weights, tests, pmc, est) {
  const today = pmc.filter(p => !p.isFuture).slice(-1)[0] || null;
  const wt = weightTrend(weights);
  const curWeight = wt.smooth || settings.defaultWeightKg;

  // small freshness effect: fresher -> marginally faster (bounded ±3%)
  const formBonus = today ? clamp(today.tsb / 800, -0.03, 0.03) : 0;

  // today's predicted efforts from run threshold speed
  const efforts = {};
  if (est.runThresholdSpeed.value) {
    const v = est.runThresholdSpeed.value * (1 + formBonus);
    const anchorD = v * 3600; // distance in ~1h at threshold
    efforts.run5k = riegel(3600, anchorD, 5000);
    efforts.run10k = riegel(3600, anchorD, 10000);
    efforts.runThresholdPace = 1000 / v;
  }
  if (est.cssSpeed.value) efforts.cssPace = 100 / est.cssSpeed.value;
  if (est.lthr.value) efforts.thresholdHr = est.lthr.value;

  // Ironman finish projection
  let ironman = null;
  if (est.cssSpeed.value || est.runThresholdSpeed.value) {
    const baseW = settings.raceBaselineWeight || curWeight;
    // run economy: lighter than baseline -> faster (bounded)
    const wAdj = 1 - (settings.weightEconomyPct / 100) * ((baseW - curWeight) / baseW);
    const swimSpeed = est.cssSpeed.value ? est.cssSpeed.value / settings.imSwimFactor : null;
    const swimSec = swimSpeed ? 3800 / swimSpeed : null;

    let bikeKmh = settings.imBikeTargetKmh;
    if (!bikeKmh) {
      const longRides = activities.filter(a => a.sport === 'bike' && a.avgSpeed && (a.durationSec || 0) >= 90 * 60);
      bikeKmh = longRides.length ? (Math.max(...longRides.map(a => a.avgSpeed)) * 3.6) : 30;
    }
    const bikeSec = 180 / bikeKmh * 3600;

    const runThrPace = est.runThresholdSpeed.value ? 1000 / est.runThresholdSpeed.value : 300;
    const marathonPace = runThrPace * settings.imRunFactor * clamp(wAdj, 0.93, 1.05);
    const runSec = marathonPace * 42.195;

    const transitions = settings.transitionsMin * 60;
    const total = (swimSec || 0) + bikeSec + runSec + transitions;
    ironman = {
      swimSec, bikeSec, runSec, transitions, total,
      bikeKmh, marathonPacePerKm: marathonPace,
      assumptions: { imSwimFactor: settings.imSwimFactor, imBikeIF: settings.imBikeIF, imRunFactor: settings.imRunFactor, weightAdj: wAdj },
      note: 'Bike split is the least certain without power — it uses your recent long-ride speed and terrain will move it.',
    };
  }

  // race readiness for the target date
  let readiness = null;
  if (settings.raceDate) {
    const raceRow = pmc.find(p => p.day === settings.raceDate) || today;
    const tsb = raceRow ? raceRow.tsb : (today ? today.tsb : 0);
    const ctl = raceRow ? raceRow.ctl : (today ? today.ctl : 0);
    // form: best around +8..+18
    const formScore = clamp(100 - Math.abs(tsb - 13) * 4, 0, 100);
    // fitness: relative to current, trending up is good; scale by ctl magnitude
    const fitnessScore = clamp((ctl / (settings.readyCtlTarget || 90)) * 100, 0, 100);
    // weight stability: penalize rapid drop
    const weightScore = clamp(100 - Math.max(0, wt.dropPct7 - 0.5) * 30, 0, 100);
    const score = Math.round(0.45 * formScore + 0.40 * fitnessScore + 0.15 * weightScore);
    readiness = { score, parts: { formScore: Math.round(formScore), fitnessScore: Math.round(fitnessScore), weightScore: Math.round(weightScore) }, tsb, ctl,
      daysOut: Math.ceil((new Date(settings.raceDate) - new Date()) / 86400000) };
  }

  return { efforts, ironman, readiness, weight: { current: curWeight, smooth: wt.smooth, dropPct7: wt.dropPct7 }, formBonus };
}

export const fmtClock = clock;

// Exposed for unit tests only.
export const _internal = { solve3, fitLinear, ewmaSeries, riegel, percentile };
