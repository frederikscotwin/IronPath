// model.js — IronPath analytics engine
// -----------------------------------------------------------------------------
// The whole point of this module is transparency: every number the app shows you
// comes from a formula in this file, and every constant those formulas use lives
// in `settings` (see store.js -> DEFAULT_SETTINGS) so you can inspect and change
// it. Nothing is a black box.
//
// The unified training-load currency is heart-rate TRIMP (Banister), because it
// is the one signal you have across swim, bike AND run. On top of daily load we
// run the classic impulse-response model (the "Performance Management Chart"):
//   Fitness (CTL) = slow exponential average of load  (default 42-day)
//   Fatigue (ATL) = fast exponential average of load  (default  7-day)
//   Form    (TSB) = yesterday's Fitness - yesterday's Fatigue
// -----------------------------------------------------------------------------

// ---- small helpers ----------------------------------------------------------

export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Local calendar day key "YYYY-MM-DD" for a Date or ISO string.
export function dayKey(d) {
  const t = (d instanceof Date) ? d : new Date(d);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const day = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + n);
  return dayKey(t);
}

// Inclusive list of day keys from a..b.
export function dayRange(a, b) {
  const out = [];
  let cur = a;
  let guard = 0;
  while (cur <= b && guard < 100000) { out.push(cur); cur = addDays(cur, 1); guard++; }
  return out;
}

// ---- intensity -> heart-rate reserve ----------------------------------------

// Heart-rate reserve fraction from average HR. 0 = resting, 1 = max.
export function hrReserve(avgHr, settings) {
  const { maxHr, restHr } = settings;
  if (!avgHr || !maxHr || !restHr || maxHr <= restHr) return null;
  return clamp((avgHr - restHr) / (maxHr - restHr), 0, 1);
}

// When there is no HR at all, we estimate an effective reserve so a session still
// contributes something. RPE (session rating of perceived exertion, 1-10) is the
// best fallback; a per-sport default is the last resort. The mapping is linear
// and lives in settings.rpeToReserve so you can retune it.
export function reserveFromRpe(rpe, settings) {
  if (rpe == null) return null;
  const { base, slope } = settings.rpeToReserve; // reserve = base + slope*rpe
  return clamp(base + slope * rpe, 0, 1);
}

// ---- canonical load: Banister TRIMP -----------------------------------------

// TRIMP = minutes * HRr * 0.64 * e^(b*HRr).  b encodes the exponential weighting
// of hard vs easy time (Banister used 1.92 for men, 1.67 for women).
export function trimp(durationMin, reserve, settings) {
  if (!durationMin || reserve == null) return 0;
  const b = settings.trimpB;
  return durationMin * reserve * 0.64 * Math.exp(b * reserve);
}

// Compute the canonical load (in TRIMP units) for one activity, returning both
// the number and how confident we are in it (so the UI can flag estimates).
export function activityLoad(act, settings) {
  const durMin = (act.durationSec || 0) / 60;
  if (durMin <= 0) return { load: 0, reserve: null, method: 'none', confidence: 'none' };

  let reserve = hrReserve(act.avgHr, settings);
  let method = 'hr', confidence = 'high';

  if (reserve == null) {
    reserve = reserveFromRpe(act.rpe, settings);
    method = 'rpe'; confidence = 'medium';
  }
  if (reserve == null) {
    reserve = settings.defaultReserveBySport[act.sport] ?? settings.defaultReserveBySport.other;
    method = 'default'; confidence = 'low';
  }
  return { load: trimp(durMin, reserve, settings), reserve, method, confidence };
}

// ---- secondary, sport-specific scores (informational) -----------------------
// These are NOT what drives the PMC (that stays unified via TRIMP). They give
// you a familiar per-sport intensity read where a better signal than HR exists.
// Convention: 100 points == one hour at threshold.  Score = 100 * hours * IF^2.

// avgSpeed in m/s; threshold speeds in m/s.
export function paceScore(act, settings) {
  const hours = (act.durationSec || 0) / 3600;
  if (hours <= 0 || !act.avgSpeed) return null;
  if (act.sport === 'swim' && settings.cssSpeed) {
    const IF = act.avgSpeed / settings.cssSpeed;
    return { type: 'sSS', IF, score: 100 * hours * IF * IF };
  }
  if (act.sport === 'run' && settings.runThresholdSpeed) {
    const IF = act.avgSpeed / settings.runThresholdSpeed;
    return { type: 'rTSS', IF, score: 100 * hours * IF * IF };
  }
  return null;
}

// Convenience: convert a pace in sec/100m (swim) or sec/km (run) to m/s.
export function per100ToMps(secPer100m) { return secPer100m ? 100 / secPer100m : null; }
export function perKmToMps(secPerKm) { return secPerKm ? 1000 / secPerKm : null; }
export function mpsToPerKm(mps) { return mps ? 1000 / mps : null; }
export function mpsToPer100(mps) { return mps ? 100 / mps : null; }

// ---- daily load series ------------------------------------------------------

// Sum canonical load per calendar day. Returns Map<dayKey, {load, bySport}>.
export function dailyLoads(activities, settings) {
  const map = new Map();
  for (const a of activities) {
    const k = dayKey(a.startTime);
    const { load } = activityLoad(a, settings);
    const cur = map.get(k) || { load: 0, bySport: {} };
    cur.load += load;
    cur.bySport[a.sport] = (cur.bySport[a.sport] || 0) + load;
    map.set(k, cur);
  }
  return map;
}

// ---- the Performance Management Chart ---------------------------------------
// Impulse-response smoothing. The recurrence is the standard exponentially
// weighted form used by TrainingPeaks-style tools:
//   X_today = X_yesterday + (load_today - X_yesterday) * (1 - e^(-1/tau))
// CTL uses a long tau (fitness accrues slowly), ATL a short one (fatigue is
// quick to rise and fall). TSB (form) is deliberately *yesterday's* fitness
// minus fatigue, so a hard day today shows as fresh legs spent, not gained.
export function performanceChart(activities, settings, opts = {}) {
  const daily = dailyLoads(activities, settings);
  const keys = [...daily.keys()].sort();
  const start = opts.start || keys[0];
  const end = opts.end || dayKey(new Date());
  if (!start) return [];

  const ctlTau = settings.ctlDays;
  const atlTau = settings.atlDays;
  const ctlK = 1 - Math.exp(-1 / ctlTau);
  const atlK = 1 - Math.exp(-1 / atlTau);

  // Optional planned future load extends the projection past today.
  const planned = opts.plannedDaily || new Map();

  let ctl = settings.seedCtl || 0;
  let atl = settings.seedAtl || 0;
  const out = [];
  for (const day of dayRange(start, end)) {
    const actual = daily.get(day);
    const plan = planned.get(day);
    const load = (actual ? actual.load : 0) + (plan ? plan : 0);
    const prevCtl = ctl, prevAtl = atl;
    ctl = prevCtl + (load - prevCtl) * ctlK;
    atl = prevAtl + (load - prevAtl) * atlK;
    out.push({
      day,
      load,
      actualLoad: actual ? actual.load : 0,
      plannedLoad: plan || 0,
      bySport: actual ? actual.bySport : {},
      ctl,          // fitness
      atl,          // fatigue
      tsb: prevCtl - prevAtl, // form (based on yesterday)
      isFuture: day > dayKey(new Date()),
    });
  }
  return out;
}

// CTL ramp rate over the trailing `window` days (points/day of fitness gain).
export function rampRate(pmc, windowDays = 7) {
  if (pmc.length < 2) return 0;
  const last = pmc[pmc.length - 1];
  const idx = Math.max(0, pmc.length - 1 - windowDays);
  const prev = pmc[idx];
  const days = Math.max(1, (pmc.length - 1) - idx);
  return (last.ctl - prev.ctl) / days * 7; // expressed per week
}

// ---- weekly rollups ---------------------------------------------------------

export function weeklyVolume(activities, settings) {
  // Returns array of { weekStart(dayKey, Monday), hours, load, bySport:{} } sorted.
  const weeks = new Map();
  for (const a of activities) {
    const d = new Date(a.startTime);
    const dow = (d.getDay() + 6) % 7; // Monday=0
    const monday = addDays(dayKey(d), -dow);
    const { load } = activityLoad(a, settings);
    const w = weeks.get(monday) || { weekStart: monday, seconds: 0, load: 0, bySport: {} };
    w.seconds += a.durationSec || 0;
    w.load += load;
    w.bySport[a.sport] = (w.bySport[a.sport] || 0) + (a.durationSec || 0);
    weeks.set(monday, w);
  }
  return [...weeks.values()]
    .map(w => ({ ...w, hours: w.seconds / 3600 }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ---- suggestions ------------------------------------------------------------
// Simple, legible rules over the model. Each returns {level, title, detail}.
export function suggestions(pmc, settings, plan) {
  const out = [];
  if (!pmc.length) {
    out.push({ level: 'info', title: 'No data yet',
      detail: 'Import a .fit/.tcx/.gpx file or add a session manually to start building your fitness picture.' });
    return out;
  }
  const today = pmc.filter(p => !p.isFuture).slice(-1)[0] || pmc[pmc.length - 1];
  const tsb = today.tsb;
  const ramp = rampRate(pmc.filter(p => !p.isFuture));

  if (tsb < settings.tsbDeepFatigue) {
    out.push({ level: 'warn', title: 'Deep fatigue',
      detail: `Form is ${tsb.toFixed(0)} (below ${settings.tsbDeepFatigue}). You're carrying a lot of fatigue — protect an easy day or a recovery block before pushing again.` });
  } else if (tsb < -8) {
    out.push({ level: 'info', title: 'Building — carrying fatigue',
      detail: `Form is ${tsb.toFixed(0)}. Normal for a build phase; keep an eye on sleep and easy-day discipline.` });
  } else if (tsb > settings.tsbVeryFresh) {
    out.push({ level: 'info', title: 'Very fresh',
      detail: `Form is +${tsb.toFixed(0)}. Great near a race; mid-build it can mean you've backed off more than intended.` });
  }

  if (ramp > settings.rampWarn) {
    out.push({ level: 'warn', title: 'Fitness ramping fast',
      detail: `Fitness is rising ~${ramp.toFixed(1)}/week (over ${settings.rampWarn} is a common injury-risk threshold). Consider holding volume steady for a week.` });
  }

  const alarming = tsb < settings.tsbDeepFatigue || ramp > settings.rampWarn;
  if (!alarming && today.ctl > 0) {
    const rampTxt = ramp >= 0.3 ? `rising ~${ramp.toFixed(1)}/week` : ramp <= -0.3 ? `easing ~${Math.abs(ramp).toFixed(1)}/week` : 'holding steady';
    out.push({ level: 'good', title: 'Healthy progression',
      detail: `Fitness ${today.ctl.toFixed(0)}, ${rampTxt}, form ${tsb > 0 ? '+' : ''}${tsb.toFixed(0)}. This is the sweet spot for base building — keep the aerobic volume coming.` });
  }

  if (!out.length) {
    out.push({ level: 'info', title: 'Steady',
      detail: `Fitness ${today.ctl.toFixed(0)}, form ${tsb > 0 ? '+' : ''}${tsb.toFixed(0)}. Nothing flagged — log your next sessions and the picture will sharpen.` });
  }

  return out;
}

// Aggregate a plan's planned sessions into a Map<dayKey, load> for projection.
export function plannedDailyLoads(plan, settings) {
  const map = new Map();
  if (!plan || !plan.sessions) return map;
  for (const s of plan.sessions) {
    if (!s.date) continue;
    let load = s.targetLoad;
    if (load == null && s.targetDurationSec && s.targetReserve != null) {
      load = trimp(s.targetDurationSec / 60, s.targetReserve, settings);
    }
    if (load == null && s.targetDurationSec) {
      const r = settings.defaultReserveBySport[s.sport] ?? settings.defaultReserveBySport.other;
      load = trimp(s.targetDurationSec / 60, r, settings);
    }
    map.set(s.date, (map.get(s.date) || 0) + (load || 0));
  }
  return map;
}
