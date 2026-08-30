import { readFileSync } from 'fs';
import * as M from '../js/model.js';
import * as E from '../js/estimate.js';
import { parseFit, _internal } from '../js/parsers.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

const settings = {
  maxHr: 190, restHr: 45, trimpB: 1.92, gender: 'male', age: 34,
  rpeToReserve: { base: 0.4, slope: 0.05 },
  defaultReserveBySport: { swim: 0.7, bike: 0.65, run: 0.72, strength: 0.5, other: 0.6 },
  cssSpeed: 1.0, runThresholdSpeed: 3.7, ctlDays: 42, atlDays: 7, seedCtl: 0, seedAtl: 0,
  loadBasis: 'combined', energyBlend: 0.5, defaultWeightKg: 75, zoneModel: 'lthr',
};

console.log('mean-max (windowsBest)');
// build a stream: 60 min, 1 pt/10s, hard 9 m/s block from 20-40 min, else 3 m/s
const pts = [];
let d = 0;
for (let i = 0; i <= 360; i++) { const t = i * 10; const mins = t / 60; const v = (mins >= 20 && mins <= 40) ? 9 : 3; d += v * 10; pts.push({ t, d, hr: (mins >= 20 && mins <= 40) ? 170 : 130 }); }
const mm = _internal.meanMax(pts);
ok('has 20-min best', !!mm.dur['20']);
ok('best-20 speed ~ hard block (9)', Math.abs(mm.dur['20'].speed - 9) < 0.3, mm.dur['20'].speed);
ok('best-60 speed < best-20 (diluted)', mm.dur['60'].speed < mm.dur['20'].speed, JSON.stringify(mm.dur['60']));
ok('best-20 HR ~170', Math.abs(mm.dur['20'].hr - 170) < 3, mm.dur['20'].hr);

console.log('FIT record streams (independent encoder)');
const b = readFileSync('tests/samples/ride.fit');
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const a = parseFit(ab, 'ride.fit')[0];
ok('session summary still bike/3600s', a.sport === 'bike' && a.durationSec === 3600);
ok('FIT produced a best-effort curve', !!(a.best && a.best.dur), JSON.stringify(a.best));
ok('FIT best-20 speed ~9.6 (hard block)', Math.abs(a.best.dur['20'].speed - 9.6) < 0.3, a.best.dur['20'].speed);
ok('FIT best-60 < best-20', a.best.dur['60'].speed < a.best.dur['20'].speed);
ok('FIT best-20 HR ~168', Math.abs(a.best.dur['20'].hr - 168) < 4, a.best.dur['20'].hr);

console.log('combined load basis invariants');
const acts = [];
let day = '2026-07-01';
for (let i = 0; i < 20; i++) { acts.push({ sport: 'run', durationSec: 3600, avgHr: 130 + (i % 5) * 12, startTime: day + 'T09:00' }); day = M.addDays(day, 1); }
const weights = [{ date: '2026-07-01', kg: 78 }];
const daily = M.dailyLoads(acts, settings, weights);
const scale = M.basisScale(daily, 'combined');
let sumT = 0, sumE = 0, sumC = 0;
for (const v of daily.values()) { sumT += v.load; sumE += v.energy; sumC += M.resolveLoad(v, 'combined', 0.5, scale); }
ok('scale = ΣTRIMP/Σenergy', approx(scale, sumT / sumE, 1e-9), `${scale}`);
ok('combined total == TRIMP total (rescaled, any blend)', approx(sumC, sumT, 1e-6), `${sumC} vs ${sumT}`);
let sumC7 = 0; for (const v of daily.values()) sumC7 += M.resolveLoad(v, 'combined', 0.7, scale);
ok('invariant holds at blend 0.7 too', approx(sumC7, sumT, 1e-6));
const first = [...daily.values()][0];
ok('energy basis returns energy', M.resolveLoad(first, 'energy', 0.5, scale) === first.energy);
ok('trimp basis returns trimp', M.resolveLoad(first, 'trimp', 0.5, scale) === first.load);

console.log('estimation prefers best-20 efforts');
const s2 = { ...settings };
const acts2 = [
  { sport: 'run', durationSec: 3600, avgHr: 150, maxHr: 184, avgSpeed: 3.3, startTime: '2026-08-01T09:00', best: { dur: { '20': { speed: 4.0, hr: 172 }, '60': { speed: 3.4, hr: 150 } } } },
  { sport: 'run', durationSec: 3600, avgHr: 148, maxHr: 182, avgSpeed: 3.2, startTime: '2026-08-03T09:00', best: { dur: { '20': { speed: 3.9, hr: 170 } } } },
  { sport: 'run', durationSec: 3600, avgHr: 149, maxHr: 183, avgSpeed: 3.25, startTime: '2026-08-05T09:00', best: { dur: { '20': { speed: 3.95, hr: 171 } } } },
];
const est = E.estimateThresholds(acts2, [], s2);
ok('run threshold from best-20 (max 4.0 × 0.96)', approx(est.runThresholdSpeed.value, 4.0 * 0.96, 1e-6), est.runThresholdSpeed.value);
ok('run threshold source = 20-min effort', est.runThresholdSpeed.source === '20-min effort', est.runThresholdSpeed.source);
ok('LTHR from best-20 HR (max 172)', est.lthr.value === 172, est.lthr.value);
ok('LTHR source = 20-min effort', est.lthr.source === '20-min effort');
// without best efforts, falls back to summary averages
const acts3 = acts2.map(x => ({ ...x, best: undefined }));
const est3 = E.estimateThresholds(acts3, [], s2);
ok('falls back to session-avg when no streams', est3.runThresholdSpeed.source === 'history');

console.log('best-effort curve aggregation');
const curve = E.bestEffortCurve(acts2);
ok('curve has run bests', curve.run && curve.run['20'] && approx(curve.run['20'].speed, 4.0, 1e-9));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
