import * as M from '../js/model.js';
import * as A from '../js/adapt.js';
import * as PL from '../js/plan.js';
import { racePlan } from '../js/race.js';
import { streamMetrics } from '../js/parsers.js';
import { buildWorkoutFit, decodeWorkoutFit, generateWorkoutFromSession, workoutToText } from '../js/fitworkout.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

const settings = {
  trimpB: 1.92, tsbDeepFatigue: -25, tsbVeryFresh: 15,
  acwrHigh: 1.5, acwrLow: 0.8, monotonyHigh: 2.5, adaptHorizonDays: 7, adaptCutPct: 0.6,
  fuelCarbsPerHr: 80, fuelFluidMlPerHr: 600, fuelSodiumMgPerHr: 700, taperWeeks: 3,
  imSwimFactor: 1.06, imRunFactor: 1.10,
};

// ---- helper to fake a PMC series -------------------------------------------
function fakePmc(loads, tsb) {
  const today = M.dayKey(new Date());
  const n = loads.length;
  return loads.map((L, i) => ({ day: M.addDays(today, i - (n - 1)), actualLoad: L, tsb, ctl: 60, atl: 60 - tsb, isFuture: false }));
}

console.log('fatigue signals (ACWR / monotony)');
const steady = A.fatigueSignals(fakePmc(Array(28).fill(100), 0));
ok('steady ACWR ~ 1', approx(steady.acwr, 1, 0.02), steady.acwr);
const spikeLoads = [...Array(21).fill(50), ...Array(7).fill(150)];
const spike = A.fatigueSignals(fakePmc(spikeLoads, -30));
ok('load spike ACWR > 1.5', spike.acwr > 1.5, spike.acwr);
ok('monotony is finite/positive', spike.monotony > 0);

console.log('daily readiness');
const rdRed = A.dailyReadiness(spike, { dropPct7: 0 }, settings);
ok('overload -> red/low', rdRed.color === 'red' || rdRed.score < 50, JSON.stringify(rdRed));
const rdGreen = A.dailyReadiness(A.fatigueSignals(fakePmc(Array(28).fill(80), 5)), { dropPct7: 0 }, settings);
ok('balanced -> green', rdGreen.color === 'green', JSON.stringify(rdGreen));

console.log('adaptation pass');
const today = M.dayKey(new Date());
const plan = { phases: [], sessions: [
  { id: 's1', date: M.addDays(today, 1), sport: 'bike', title: 'Long ride', targetLoad: 200, targetDurationSec: 9000 },
  { id: 's2', date: M.addDays(today, 2), sport: 'run', title: 'Tempo', targetLoad: 120, targetDurationSec: 3600 },
  { id: 's3', date: M.addDays(today, 3), sport: 'swim', title: 'Easy', targetLoad: 50, targetDurationSec: 2700 },
] };
const adapt = A.adaptationSuggestions(plan, spike, settings);
ok('overload state', adapt.state === 'overload', adapt.state);
ok('reduces the two hardest sessions', adapt.changes.length === 2 && adapt.changes.every(c => c.kind === 'reduce'));
ok('hardest (bike 200) cut ~40%', approx(adapt.changes[0].toLoad, Math.round(200 * 0.6), 1), adapt.changes[0].toLoad);
const applied = A.applyAdaptation(plan, adapt.changes);
ok('applied plan has reduced load + adapted flag', applied.sessions.find(s => s.id === 's1').targetLoad === 120 && applied.sessions.find(s => s.id === 's1').adapted === 'reduce');
// realistic week has rest-day variation, so monotony stays moderate
const balancedLoads = Array.from({ length: 28 }, (_, i) => [90, 100, 70, 110, 0, 120, 80][i % 7]);
const balancedSig = A.fatigueSignals(fakePmc(balancedLoads, 3));
ok('monotony computed for varied week', balancedSig.monotony > 0 && balancedSig.monotony < 2.5, balancedSig.monotony);
const onTrack = A.adaptationSuggestions(plan, balancedSig, settings);
ok('balanced -> no changes', onTrack.state === 'ontrack' && onTrack.changes.length === 0, onTrack.state);

console.log('taper generator');
const raceDate = M.addDays(today, 27);
const taperPmc = fakePmc(Array(40).fill(85), 0).map(p => ({ ...p, ctl: 70 }));
const taper = PL.generateTaper({ ...settings, raceDate }, taperPmc);
ok('taper produced sessions', taper.sessions.length > 0);
ok('all taper sessions on/before race date', taper.sessions.every(s => s.date <= raceDate));
ok('weekly load decreases toward race', taper.summary[0].load > taper.summary[taper.summary.length - 1].load, JSON.stringify(taper.summary.map(s => s.load)));
const merged = PL.applyTaper({ phases: [], sessions: [{ id: 'old', date: M.addDays(today, 20), sport: 'run', targetLoad: 300 }] }, taper);
ok('applyTaper adds Taper phase', merged.phases.some(p => p.name === 'Taper'));
ok('applyTaper removed pre-existing session in window', !merged.sessions.some(s => s.id === 'old'));

console.log('race-day pacing + fuelling');
const pred = { ironman: { swimSec: 4200, bikeSec: 21600, runSec: 15000, transitions: 480, total: 41280, bikeKmh: 30, marathonPacePerKm: 355 } };
const est = { lthr: { value: 165 }, cssSpeed: { value: 1.0 }, runThresholdSpeed: { value: 3.6 } };
const rp = racePlan(pred, est, settings, 75);
ok('three pacing legs', rp.pacing.length === 3);
ok('bike HR band from LTHR', rp.pacing[1].hr.includes('–'));
ok('fuelling carbs total > 0', rp.fuelling.totals.carbsG > 0, rp.fuelling.totals.carbsG);
ok('fuelling only counts bike+run hours', approx(rp.bikeRunHours, (21600 + 15000) / 3600, 0.05), rp.bikeRunHours);

console.log('durability (decoupling) + GAP');
// decoupling: constant HR, second half slower -> positive decoupling
const decoupStream = [];
for (let t = 0; t <= 3600; t += 30) { const v = t < 1800 ? 3.2 : 2.9; decoupStream.push({ t, d: (decoupStream.length ? decoupStream[decoupStream.length - 1].d : 0) + v * 30, hr: 150, ele: 0 }); }
const dm = streamMetrics(decoupStream, 'run');
ok('decoupling positive when pace fades', dm.decoupling > 3, dm.decoupling);
// GAP: uphill run -> grade-adjusted best > raw best
const upStream = [];
let dd = 0, ee = 0;
for (let t = 0; t <= 1500; t += 15) { dd += 3 * 15; ee += 0.06 * (3 * 15); upStream.push({ t, d: dd, hr: 150, ele: ee }); } // 6% grade
const um = streamMetrics(upStream, 'run');
ok('uphill GAP speed > raw speed', um.gapBest && um.best && um.gapBest.dur['20'].speed > um.best.dur['20'].speed, JSON.stringify([um.gapBest?.dur?.['20'], um.best?.dur?.['20']]));

console.log('FIT workout encode → decode round-trip');
const wk = generateWorkoutFromSession({ sport: 'run', title: '5×5min threshold', targetDurationSec: 3600, targetReserve: 0.85 }, 165, settings);
ok('generated has warmup + intervals + cooldown', wk.steps.length >= 5 && wk.steps[0].intensity === 'warmup');
const bytes = buildWorkoutFit(wk);
ok('FIT signature present', String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === '.FIT');
const dec = decodeWorkoutFit(bytes.buffer);
ok('round-trip sport = run', dec.sport === 'run', dec.sport);
ok('round-trip step count matches', dec.steps.length === wk.steps.length, `${dec.steps.length} vs ${wk.steps.length}`);
const firstHrStep = wk.steps.find(s => s.target?.type === 'hr');
const firstHrDec = dec.steps.find(s => s.lo > 100);
ok('HR target survives round-trip (bpm = stored-100)', firstHrDec && (firstHrDec.lo - 100) === firstHrStep.target.lo, JSON.stringify([firstHrDec, firstHrStep.target]));
ok('workoutToText renders', workoutToText(wk).includes('Warm-up'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
