// plan.js — plan data helpers. A plan is fully editable data:
//   { phases:[{name,startDate,weeks,focus}], sessions:[{id,date,sport,title,
//     targetDurationSec,targetReserve,targetLoad,done,notes}] }
// The plan never overrides you — it's a set of suggestions you reshape at will.
// generateBase() just seeds a sensible base-building block to edit.

import { addDays, dayKey, trimp } from './model.js';

let idc = 0;
function sid() { return 'p' + Date.now().toString(36) + (idc++).toString(36); }

// A pragmatic base-building week for ~weeklyHours, biased to aerobic volume with
// two of each discipline plus one long ride and one long run.
export function generateBase(settings, opts = {}) {
  const weeklyHours = opts.weeklyHours ?? 8;
  const weeks = opts.weeks ?? 12;
  const startMonday = opts.startDate || mondayOf(dayKey(new Date()));
  const H = weeklyHours;

  // Fractions of weekly time per session (sums ~1.0). Reserve = target intensity.
  const template = [
    { dow: 0, sport: 'swim', title: 'Swim — technique + drills', frac: 0.11, reserve: 0.62 },
    { dow: 1, sport: 'bike', title: 'Bike — endurance Z2',        frac: 0.16, reserve: 0.60 },
    { dow: 2, sport: 'run',  title: 'Run — easy aerobic',         frac: 0.11, reserve: 0.62 },
    { dow: 3, sport: 'swim', title: 'Swim — CSS intervals',       frac: 0.10, reserve: 0.78 },
    { dow: 4, sport: 'bike', title: 'Bike — tempo',               frac: 0.13, reserve: 0.72 },
    { dow: 5, sport: 'bike', title: 'Long ride — steady Z2',      frac: 0.22, reserve: 0.60 },
    { dow: 6, sport: 'run',  title: 'Long run — easy',            frac: 0.17, reserve: 0.63 },
  ];

  const sessions = [];
  for (let w = 0; w < weeks; w++) {
    // gentle 3-up / 1-recovery undulation
    const inCycle = w % 4;
    const loadMult = inCycle === 3 ? 0.70 : 0.90 + inCycle * 0.05; // 0.90,0.95,1.00,0.70
    const weekHours = H * loadMult;
    const weekStart = addDays(startMonday, w * 7);
    for (const t of template) {
      const durSec = Math.round(weekHours * 3600 * t.frac);
      if (durSec < 600) continue;
      sessions.push({
        id: sid(),
        date: addDays(weekStart, t.dow),
        sport: t.sport,
        title: t.title,
        targetDurationSec: durSec,
        targetReserve: t.reserve,
        targetLoad: Math.round(trimp(durSec / 60, t.reserve, settings)),
        done: false,
        notes: '',
      });
    }
  }
  const phases = [{ name: 'Base', startDate: startMonday, weeks, focus: 'Aerobic base + technique' }];
  return { phases, sessions };
}

export function mondayOf(dstr) {
  const d = new Date(dstr);
  const dow = (d.getDay() + 6) % 7;
  return addDays(dayKey(d), -dow);
}

export function newSession(date, sport = 'run') {
  return { id: sid(), date, sport, title: '', targetDurationSec: 3600, targetReserve: 0.65, targetLoad: null, done: false, notes: '' };
}

// ---- taper ------------------------------------------------------------------
// Back-solve a taper for the final `taperWeeks` before the race: progressively
// reduce volume (keep a little intensity so you stay sharp), rest the day before.
// Returns taper sessions + a per-week summary; the app recomputes the PMC to show
// the projected race-day form.
export function generateTaper(settings, pmc) {
  const race = settings.raceDate;
  if (!race) return null;
  const past = (pmc || []).filter(p => !p.isFuture);
  const ctl = past.length ? past[past.length - 1].ctl : 60;
  const weeklyBase = Math.max(1, ctl * 7);         // maintenance week ≈ fitness×7
  const weeks = Math.max(1, settings.taperWeeks || 3);
  const raceMon = mondayOf(race);
  const raceDow = (new Date(race).getDay() + 6) % 7;
  const fracFor = (w) => weeks > 1 ? (0.72 - 0.34 * (w / (weeks - 1))) : 0.5;
  const invMin = (L, r) => L / (r * 0.64 * Math.exp((settings.trimpB || 1.92) * r));

  const sessions = [], summary = [];
  for (let w = 0; w < weeks; w++) {
    const idxFromRace = weeks - 1 - w;             // 0 = race week
    const weekLoad = weeklyBase * fracFor(w);
    const weekStart = addDays(raceMon, -idxFromRace * 7);
    let tpl = [
      { dow: 0, sport: 'swim', title: 'Swim — easy + short efforts', f: 0.16, r: 0.66 },
      { dow: 1, sport: 'bike', title: 'Bike — easy with 3×3 min', f: 0.24, r: 0.68 },
      { dow: 2, sport: 'run', title: 'Run — easy + strides', f: 0.18, r: 0.66 },
      { dow: 3, sport: 'swim', title: 'Swim — technique', f: 0.12, r: 0.60 },
      { dow: 4, sport: 'bike', title: 'Bike — short sharpener', f: 0.16, r: 0.72 },
      { dow: 5, sport: 'run', title: 'Run — short + strides', f: 0.14, r: 0.68 },
    ];
    if (idxFromRace === 0) {
      tpl = tpl.filter(t => t.dow <= raceDow - 2);
      tpl.push({ dow: Math.max(0, raceDow - 1), sport: 'run', title: 'Opener — 15 min easy + 4 strides', f: 0.05, r: 0.66 });
    }
    let wLoad = 0;
    for (const t of tpl) {
      const load = Math.round(weekLoad * t.f);
      if (load < 10) continue;
      sessions.push({ id: sid(), date: addDays(weekStart, t.dow), sport: t.sport, title: t.title,
        targetDurationSec: Math.round(invMin(load, t.r) * 60), targetReserve: t.r, targetLoad: load, done: false, notes: 'taper', phase: 'Taper' });
      wLoad += load;
    }
    summary.push({ weekStart, frac: +fracFor(w).toFixed(2), load: Math.round(wLoad) });
  }
  return { sessions, summary, raceDate: race };
}

export function applyTaper(plan, taper) {
  if (!taper || !taper.summary.length) return plan;
  const start = taper.summary[0].weekStart, race = taper.raceDate;
  const kept = (plan.sessions || []).filter(s => s.date < start || s.date > race);
  const phases = [...(plan.phases || []).filter(p => p.name !== 'Taper'),
    { name: 'Taper', startDate: start, weeks: taper.summary.length, focus: 'Sharpen + freshen' }];
  return { ...plan, phases, sessions: [...kept, ...taper.sessions].sort((a, b) => a.date.localeCompare(b.date)) };
}

// Group sessions by week (Monday) for display.
export function sessionsByWeek(plan) {
  const map = new Map();
  for (const s of (plan.sessions || [])) {
    const wk = mondayOf(s.date);
    if (!map.has(wk)) map.set(wk, []);
    map.get(wk).push(s);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
