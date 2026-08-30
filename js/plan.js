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
