import * as M from '../js/model.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

const settings = {
  maxHr: 190, restHr: 50, trimpB: 1.92,
  rpeToReserve: { base: 0.4, slope: 0.05 },
  defaultReserveBySport: { swim: 0.7, bike: 0.65, run: 0.72, strength: 0.5, other: 0.6 },
  cssSpeed: 1.0, runThresholdSpeed: 3.70,
  ctlDays: 42, atlDays: 7, seedCtl: 0, seedAtl: 0,
  tsbDeepFatigue: -25, tsbVeryFresh: 15, rampWarn: 8,
};

console.log('date helpers');
ok('dayKey', M.dayKey(new Date(2026, 0, 15)) === '2026-01-15');
ok('addDays fwd', M.addDays('2026-01-30', 3) === '2026-02-02');
ok('addDays back over month', M.addDays('2026-03-01', -1) === '2026-02-28');
ok('dayRange length', M.dayRange('2026-01-01', '2026-01-10').length === 10);

console.log('hr reserve + trimp');
const r = M.hrReserve(140, settings);
ok('reserve 140bpm', approx(r, (140 - 50) / (190 - 50), 1e-9), r);
const t60 = M.trimp(60, r, settings);
// hand-computed expected
const exp = 60 * r * 0.64 * Math.exp(1.92 * r);
ok('trimp 60min matches formula', approx(t60, exp, 1e-6), `${t60} vs ${exp}`);
ok('trimp monotonic in intensity', M.trimp(60, 0.8, settings) > M.trimp(60, 0.5, settings));
ok('trimp monotonic in duration', M.trimp(90, r, settings) > M.trimp(60, r, settings));
ok('trimp zero when no reserve', M.trimp(60, null, settings) === 0);

console.log('rpe fallback');
ok('rpe 10 -> 0.9', approx(M.reserveFromRpe(10, settings), 0.9, 1e-9));
ok('rpe clamped <=1', M.reserveFromRpe(20, settings) === 1);

console.log('activityLoad method selection');
ok('uses hr when present', M.activityLoad({ sport: 'run', durationSec: 3600, avgHr: 140 }, settings).method === 'hr');
ok('falls back to rpe', M.activityLoad({ sport: 'run', durationSec: 3600, rpe: 6 }, settings).method === 'rpe');
ok('falls back to default', M.activityLoad({ sport: 'run', durationSec: 3600 }, settings).method === 'default');

console.log('pace scores');
const sSS = M.paceScore({ sport: 'swim', durationSec: 3600, avgSpeed: 1.0 }, settings);
ok('sSS = 100 at threshold for 1h', approx(sSS.score, 100, 1e-6), JSON.stringify(sSS));
const rTSS = M.paceScore({ sport: 'run', durationSec: 3600, avgSpeed: 3.70 }, settings);
ok('rTSS = 100 at threshold for 1h', approx(rTSS.score, 100, 1e-6), JSON.stringify(rTSS));

console.log('PMC convergence (constant daily load)');
// One 60-min run per day at 140bpm for 250 days -> CTL/ATL converge to that load.
const oneLoad = M.trimp(60, r, settings);
const acts = [];
let d = '2025-01-01';
for (let i = 0; i < 250; i++) { acts.push({ sport: 'run', durationSec: 3600, avgHr: 140, startTime: d + 'T09:00:00' }); d = M.addDays(d, 1); }
const pmc = M.performanceChart(acts, settings, { start: '2025-01-01', end: M.addDays('2025-01-01', 249) });
const last = pmc[pmc.length - 1];
ok('CTL converges to daily load', approx(last.ctl, oneLoad, 0.5), `${last.ctl} vs ${oneLoad}`);
ok('ATL converges to daily load', approx(last.atl, oneLoad, 0.05), `${last.atl} vs ${oneLoad}`);
ok('TSB ~ 0 at steady state', Math.abs(last.tsb) < 0.5, last.tsb);
ok('ATL reaches steady state before CTL (faster)', pmc[20].atl > pmc[20].ctl);

console.log('PMC taper (form rises when load stops)');
const acts2 = acts.slice(0, 200); // stop training after 200 days
const pmc2 = M.performanceChart(acts2, settings, { start: '2025-01-01', end: M.addDays('2025-01-01', 220) });
const afterRest = pmc2[pmc2.length - 1];
ok('TSB positive after 20 rest days', afterRest.tsb > 20, afterRest.tsb);
ok('fatigue drops below fitness after rest', afterRest.atl < afterRest.ctl);

console.log('ramp rate + weekly volume + suggestions run');
const ramp = M.rampRate(pmc);
ok('ramp near zero at steady state', Math.abs(ramp) < 1, ramp);
const wv = M.weeklyVolume(acts, settings);
ok('weekly volume buckets ~36 weeks', wv.length >= 35 && wv.length <= 37, wv.length);
ok('each full week ~7h', approx(wv[5].hours, 7, 0.01), wv[5].hours);
const sug = M.suggestions(pmc, settings, null);
ok('suggestions returns array', Array.isArray(sug) && sug.length >= 1);

console.log('\nPMC projection with planned future load (anchored on today)');
// Build a real series ending today, then plan overload for the next 14 days.
const today = M.dayKey(new Date());
const start3 = M.addDays(today, -199);
const acts3 = [];
let dd = start3;
for (let i = 0; i < 200; i++) { acts3.push({ sport: 'run', durationSec: 3600, avgHr: 140, startTime: dd + 'T09:00:00' }); dd = M.addDays(dd, 1); }
const basePmc = M.performanceChart(acts3, settings, { start: start3, end: today });
const baseCtl = basePmc[basePmc.length - 1].ctl;
const planned = new Map();
let pd = M.addDays(today, 1);
for (let i = 0; i < 14; i++) { planned.set(pd, oneLoad * 1.5); pd = M.addDays(pd, 1); }
const pmc3 = M.performanceChart(acts3, settings, { start: start3, end: M.addDays(today, 14), plannedDaily: planned });
ok('projection extends into the future', pmc3[pmc3.length - 1].isFuture === true);
ok('future days flagged, past days not', pmc3.find(p => p.day === today).isFuture === false);
ok('projected CTL rises with planned overload', pmc3[pmc3.length - 1].ctl > baseCtl, `${pmc3[pmc3.length-1].ctl} vs ${baseCtl}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
