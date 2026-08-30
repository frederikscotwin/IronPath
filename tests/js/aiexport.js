// aiexport.js — the "hand my history to an AI" bridge.
// Produces one clean, self-describing JSON payload plus a ready-made prompt so
// you can paste both into Claude (or anything) and get grounded coaching advice.
// Now includes weight, energy, auto-estimated thresholds/zones, the fitted
// self-calibration, and the performance predictions.

import { performanceChart, weeklyVolume, activityLoad, rampRate, plannedDailyLoads, weightTrend } from './model.js';
import { estimateThresholds, calibrateModel, predict, bestEffortCurve, durability } from './estimate.js';
import { fatigueSignals, dailyReadiness } from './adapt.js';
import { racePlan } from './race.js';

const clock = (sec) => { if (!sec || !isFinite(sec)) return null; const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const hms = (sec) => { if (!sec) return null; sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };

export function buildAiPayload(activities, settings, plan, weights = [], tests = []) {
  const plannedDaily = plannedDailyLoads(plan, settings);
  const pmc = performanceChart(activities, settings, { plannedDaily, weights });
  const today = pmc.filter(p => !p.isFuture).slice(-1)[0] || null;
  const weeks = weeklyVolume(activities, settings);
  const est = estimateThresholds(activities, tests, settings);
  const cal = calibrateModel(activities, settings, weights);
  const pred = predict(activities, settings, weights, tests, pmc, est);
  const wt = weightTrend(weights);

  const sessions = [...activities]
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map(a => {
      const { load, method } = activityLoad(a, settings);
      return {
        date: a.startTime.slice(0, 10), sport: a.sport,
        durationMin: Math.round((a.durationSec || 0) / 60),
        distanceKm: a.distanceM ? +(a.distanceM / 1000).toFixed(2) : null,
        avgHr: a.avgHr || null, load: Math.round(load), loadMethod: method, rpe: a.rpe ?? null,
      };
    });

  return {
    schema: 'ironpath.ai-export/2',
    generatedAt: new Date().toISOString(),
    athlete: {
      name: settings.athleteName, age: settings.age || null, gender: settings.gender,
      maxHr: settings.maxHr, restHr: settings.restHr,
      currentWeightKg: wt.smooth ? +wt.smooth.toFixed(1) : (settings.defaultWeightKg || null),
      weightTrend7dPctDrop: +wt.dropPct7.toFixed(2),
      goal: settings.raceName || 'Ironman (base building)', raceDate: settings.raceDate || null,
    },
    model: {
      loadUnit: settings.loadBasis === 'energy' ? 'kcal (energy basis)'
        : settings.loadBasis === 'combined' ? `combined TRIMP+energy (${Math.round((settings.energyBlend ?? 0.5) * 100)}% energy, rescaled to TRIMP units)`
        : 'Banister TRIMP',
      ctlDays: settings.ctlDays, atlDays: settings.atlDays,
      definitions: { CTL: 'Fitness (long EWMA of load)', ATL: 'Fatigue (short EWMA)', TSB: 'Form (yesterday CTL − ATL)' },
    },
    selfCalibration: cal.ok
      ? { fitted: true, fitnessTau: cal.tau1, fatigueTau: cal.tau2, fitnessGainK1: +cal.k1.toFixed(3), fatigueGainK2: +cal.k2.toFixed(3), rSquared: +cal.r2.toFixed(2), quality: cal.quality, points: cal.n,
          note: 'Time constants fitted to the athlete\'s own efficiency-factor performance trend. Currently applied constants are in model.ctlDays/atlDays; accept in-app to use the fitted ones.' }
      : { fitted: false, reason: cal.reason },
    estimatedThresholds: {
      maxHr: est.maxHr, restHr: est.restHr, thresholdHr: est.lthr,
      swimCssPacePer100m: est.cssSpeed.value ? { pace: clock(100 / est.cssSpeed.value), confidence: est.cssSpeed.confidence, source: est.cssSpeed.source } : null,
      runThresholdPacePerKm: est.runThresholdSpeed.value ? { pace: clock(1000 / est.runThresholdSpeed.value), confidence: est.runThresholdSpeed.confidence, source: est.runThresholdSpeed.source } : null,
      zones: est.zones,
    },
    meanMaxBySport: bestEffortCurve(activities),
    current: today ? {
      date: today.day, fitnessCTL: +today.ctl.toFixed(1), fatigueATL: +today.atl.toFixed(1),
      formTSB: +today.tsb.toFixed(1), rampPerWeek: +rampRate(pmc.filter(p => !p.isFuture)).toFixed(1),
    } : null,
    predictions: {
      today: {
        run5k: hms(pred.efforts.run5k), run10k: hms(pred.efforts.run10k),
        runThresholdPacePerKm: clock(pred.efforts.runThresholdPace), swimCssPacePer100m: clock(pred.efforts.cssPace),
        thresholdHr: pred.efforts.thresholdHr || null,
      },
      ironmanProjection: pred.ironman ? {
        swim: hms(pred.ironman.swimSec), bike: hms(pred.ironman.bikeSec), run: hms(pred.ironman.runSec),
        transitions: hms(pred.ironman.transitions), total: hms(pred.ironman.total),
        bikeKmh: +pred.ironman.bikeKmh.toFixed(1), marathonPacePerKm: clock(pred.ironman.marathonPacePerKm),
        assumptions: pred.ironman.assumptions, caveat: pred.ironman.note,
      } : null,
      raceReadiness: pred.readiness,
    },
    fatigue: (() => { const g = fatigueSignals(pmc); return g ? { formTSB: +g.tsb.toFixed(1), acwr: +g.acwr.toFixed(2), monotony: +g.monotony.toFixed(2), strain: Math.round(g.strain) } : null; })(),
    readiness: (() => dailyReadiness(fatigueSignals(pmc), wt, settings))(),
    durability: (() => { const d = durability(activities); return d.n ? { recentAvgDecouplingPct: +(d.avg || 0).toFixed(1), samples: d.n } : null; })(),
    raceDayPlan: (() => { const rp = racePlan(pred, est, settings, wt.smooth || settings.defaultWeightKg); return rp ? { total: rp.totalTime, pacing: rp.pacing.map(l => ({ leg: l.leg, split: l.time, target: l.target, hr: l.hr })), fuellingPerHour: rp.fuelling.perHour, fuellingTotals: rp.fuelling.totals } : null; })(),
    energy: {
      basis: settings.loadBasis,
      recentAvgDailyKcal: (() => {
        const since = pmc.filter(p => !p.isFuture && p.energy > 0).slice(-42);
        if (!since.length) return null;
        return Math.round(since.reduce((s, p) => s + p.energy, 0) / since.length);
      })(),
    },
    weeklyVolume: weeks.slice(-16).map(w => ({ weekStart: w.weekStart, hours: +w.hours.toFixed(1), load: Math.round(w.load) })),
    dailyModelSeries: pmc.slice(-120).map(p => ({ date: p.day, load: Math.round(p.load), ctl: +p.ctl.toFixed(1), atl: +p.atl.toFixed(1), tsb: +p.tsb.toFixed(1), kcal: Math.round(p.energy) || undefined, future: p.isFuture || undefined })),
    weightLog: wt.series.slice(-60).map(p => ({ date: p.day, kg: +p.kg.toFixed(1), smooth: +p.smooth.toFixed(1) })),
    benchmarkTests: tests,
    sessions,
    plan: plan && plan.sessions ? { phases: plan.phases, upcoming: plan.sessions.filter(s => s.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 40).map(s => ({ date: s.date, sport: s.sport, title: s.title, targetMin: Math.round((s.targetDurationSec || 0) / 60), targetLoad: s.targetLoad })) } : null,
  };
}

export function buildPrompt(payload) {
  const g = payload.athlete.goal;
  const race = payload.athlete.raceDate ? ` My race date is ${payload.athlete.raceDate}.` : ' I have no fixed race date yet and I am base-building.';
  return `You are my triathlon coach. Below is a JSON export from my personal app (IronPath) with my training history, a self-calibrating fitness model, auto-estimated thresholds/zones, my weight and energy, and the app's own performance predictions. Load is ${payload.model.loadUnit}; CTL=fitness, ATL=fatigue, TSB=form (defined in the JSON).

My goal is: ${g}.${race} I currently train roughly 6–10 hours/week.

Please:
1. Read the model series, weekly volume, weight trend and energy, and tell me plainly where my fitness, fatigue and form stand.
2. Sanity-check the app's estimatedThresholds and selfCalibration against the raw sessions — do they look right, and what single benchmark test would most improve them?
3. React to the predictions (today's efforts, the Ironman finish projection, readiness) — are the assumptions reasonable, and what would you change?
4. Recommend the shape of my next 2–3 weeks (session types, rough hours per sport, where a recovery week goes), consistent with base-building, and note any fuelling/weight concerns.

Be specific and reference the numbers. Here is the JSON:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}
