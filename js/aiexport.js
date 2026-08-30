// aiexport.js — the "hand my history to an AI" bridge.
// Produces one clean, self-describing JSON payload plus a ready-made prompt so
// you can paste both into Claude (or anything) and get grounded coaching advice.

import { performanceChart, weeklyVolume, activityLoad, rampRate, plannedDailyLoads } from './model.js';

export function buildAiPayload(activities, settings, plan) {
  const plannedDaily = plannedDailyLoads(plan, settings);
  const pmc = performanceChart(activities, settings, { plannedDaily });
  const today = pmc.filter(p => !p.isFuture).slice(-1)[0] || null;
  const weeks = weeklyVolume(activities, settings);

  const sessions = [...activities]
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map(a => {
      const { load, method } = activityLoad(a, settings);
      return {
        date: a.startTime.slice(0, 10),
        sport: a.sport,
        durationMin: Math.round((a.durationSec || 0) / 60),
        distanceKm: a.distanceM ? +(a.distanceM / 1000).toFixed(2) : null,
        avgHr: a.avgHr || null,
        load: Math.round(load),
        loadMethod: method,
        rpe: a.rpe ?? null,
      };
    });

  return {
    schema: 'ironpath.ai-export/1',
    generatedAt: new Date().toISOString(),
    athlete: {
      name: settings.athleteName,
      maxHr: settings.maxHr, restHr: settings.restHr,
      cssPacePer100m: settings.cssSpeed ? +(100 / settings.cssSpeed).toFixed(1) : null,
      runThresholdPacePerKm: settings.runThresholdSpeed ? +(1000 / settings.runThresholdSpeed).toFixed(1) : null,
      goal: settings.raceName || 'Ironman (base building)',
      raceDate: settings.raceDate || null,
    },
    model: {
      loadUnit: 'Banister TRIMP',
      ctlDays: settings.ctlDays, atlDays: settings.atlDays,
      definitions: {
        CTL: 'Fitness — long exponential average of daily load',
        ATL: 'Fatigue — short exponential average of daily load',
        TSB: 'Form — yesterday CTL minus yesterday ATL',
      },
    },
    current: today ? {
      date: today.day,
      fitnessCTL: +today.ctl.toFixed(1),
      fatigueATL: +today.atl.toFixed(1),
      formTSB: +today.tsb.toFixed(1),
      rampPerWeek: +rampRate(pmc.filter(p => !p.isFuture)).toFixed(1),
    } : null,
    weeklyVolume: weeks.slice(-16).map(w => ({
      weekStart: w.weekStart, hours: +w.hours.toFixed(1), load: Math.round(w.load),
      bySportHours: Object.fromEntries(Object.entries(w.bySport).map(([k, v]) => [k, +(v / 3600).toFixed(1)])),
    })),
    dailyModelSeries: pmc.slice(-120).map(p => ({
      date: p.day, load: Math.round(p.load),
      ctl: +p.ctl.toFixed(1), atl: +p.atl.toFixed(1), tsb: +p.tsb.toFixed(1),
      future: p.isFuture || undefined,
    })),
    sessions,
    plan: plan && plan.sessions ? {
      phases: plan.phases,
      upcoming: plan.sessions
        .filter(s => s.date >= new Date().toISOString().slice(0, 10))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 40)
        .map(s => ({ date: s.date, sport: s.sport, title: s.title, targetMin: Math.round((s.targetDurationSec || 0) / 60), targetLoad: s.targetLoad })),
    } : null,
  };
}

export function buildPrompt(payload) {
  const g = payload.athlete.goal;
  const race = payload.athlete.raceDate ? ` My race date is ${payload.athlete.raceDate}.` : ' I have no fixed race date yet and I am base-building.';
  return `You are my triathlon coach. Below is a JSON export of my training history and current fitness model from my personal app (IronPath). Training load is Banister TRIMP; CTL = fitness, ATL = fatigue, TSB = form (all defined in the JSON).

My goal is: ${g}.${race} I currently train roughly 6–10 hours/week.

Please:
1. Read the model series and weekly volume and tell me, in plain terms, where my fitness and fatigue actually stand.
2. Point out anything risky — fatigue too deep, fitness ramping too fast, or big imbalances between swim/bike/run.
3. Recommend the shape of my next 2–3 weeks (session types, rough hours per sport, where to put a recovery week), consistent with base-building.
4. Flag what data would sharpen your advice (e.g. a real CSS or run-threshold test).

Be specific and reference the numbers. Here is the JSON:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}
