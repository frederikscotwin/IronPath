// adapt.js — the auto-regulation layer: fatigue signals, a daily readiness
// light, and a rule-based adaptation pass that reshapes the upcoming plan.
// Everything is transparent and, by default, suggest-and-approve.

import { clamp, dayKey, addDays } from './model.js';

function std(a) { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }

// ---- fatigue signals from the daily-load series -----------------------------
// ACWR — acute (7d) vs chronic (28d) workload ratio; the classic 0.8–1.3 "sweet
// spot", >1.5 a danger spike. Monotony/Strain — Foster's measures: monotony is
// mean daily load over its variability (samey training is riskier), strain is
// weekly load × monotony.
export function fatigueSignals(pmc) {
  const past = pmc.filter(p => !p.isFuture);
  const today = past[past.length - 1];
  if (!today) return null;
  const loads = past.map(p => p.actualLoad || 0);
  const last7 = loads.slice(-7);
  const last28 = loads.slice(-28);
  const acute = last7.reduce((a, b) => a + b, 0);
  const chronic = last28.length ? (last28.reduce((a, b) => a + b, 0) / last28.length) * 7 : acute;
  const acwr = chronic > 0 ? acute / chronic : 0;
  const mean7 = last7.length ? acute / last7.length : 0;
  const sd7 = std(last7);
  const monotony = sd7 > 0 ? mean7 / sd7 : (mean7 > 0 ? 2.5 : 0);
  const strain = acute * monotony;
  return { tsb: today.tsb, ctl: today.ctl, atl: today.atl, acute7: acute, acwr, monotony, strain };
}

// ---- daily readiness --------------------------------------------------------
export function dailyReadiness(signals, weight, settings) {
  if (!signals) return { score: null, color: 'grey', reasons: ['No data yet'] };
  let score = 100;
  const reasons = [];
  if (signals.tsb < settings.tsbDeepFatigue) { score -= 35; reasons.push(`Form very low (${signals.tsb.toFixed(0)})`); }
  else if (signals.tsb < -10) { score -= 15; reasons.push(`Carrying fatigue (form ${signals.tsb.toFixed(0)})`); }
  if (signals.acwr > (settings.acwrHigh ?? 1.5)) { score -= 25; reasons.push(`Load spike (ACWR ${signals.acwr.toFixed(2)})`); }
  else if (signals.acwr && signals.acwr < (settings.acwrLow ?? 0.8) && signals.acute7 > 0) { score -= 8; reasons.push(`Load dropped (ACWR ${signals.acwr.toFixed(2)})`); }
  if (signals.monotony > (settings.monotonyHigh ?? 2.0)) { score -= 15; reasons.push(`High monotony (${signals.monotony.toFixed(1)})`); }
  if (weight && weight.dropPct7 > 1.5) { score -= 15; reasons.push(`Rapid weight loss (${weight.dropPct7.toFixed(1)}%/wk)`); }
  score = clamp(Math.round(score), 0, 100);
  const color = score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red';
  if (!reasons.length) reasons.push('Fresh and balanced');
  return { score, color, reasons };
}

// ---- adaptation pass --------------------------------------------------------
function overloadReason(s, settings) {
  const bits = [];
  if (s.tsb < settings.tsbDeepFatigue) bits.push(`form ${s.tsb.toFixed(0)}`);
  if (s.acwr > (settings.acwrHigh ?? 1.5)) bits.push(`ACWR ${s.acwr.toFixed(2)}`);
  if (s.monotony > (settings.monotonyHigh ?? 2.0)) bits.push(`monotony ${s.monotony.toFixed(1)}`);
  return `You're overreaching (${bits.join(', ')}) — easing the hardest upcoming sessions.`;
}

export function adaptationSuggestions(plan, signals, settings) {
  const today = dayKey(new Date());
  const horizon = addDays(today, settings.adaptHorizonDays ?? 7);
  const upcoming = (plan.sessions || []).filter(s => s.date >= today && s.date <= horizon && (s.targetLoad || 0) > 0);
  if (!signals || !upcoming.length) return { state: 'ontrack', changes: [], signals };

  // Overload cuts load only on form/ACWR. High monotony is a "add variety" nudge
  // (surfaced in readiness and advisories), not a reason to reduce volume.
  const overload = signals.tsb < settings.tsbDeepFatigue
    || signals.acwr > (settings.acwrHigh ?? 1.5);
  const detrain = signals.tsb > (settings.tsbVeryFresh ?? 15)
    && signals.acwr && signals.acwr < (settings.acwrLow ?? 0.8) && signals.acute7 > 0;

  const changes = [];
  if (overload) {
    const cut = settings.adaptCutPct ?? 0.6;
    const reason = overloadReason(signals, settings);
    const sorted = [...upcoming].sort((a, b) => (b.targetLoad || 0) - (a.targetLoad || 0));
    for (const s of sorted.slice(0, 2)) {
      changes.push({
        id: s.id, kind: 'reduce', title: s.title || cap(s.sport), sport: s.sport, date: s.date,
        fromLoad: s.targetLoad || 0, toLoad: Math.round((s.targetLoad || 0) * cut),
        toDurationSec: Math.round((s.targetDurationSec || 0) * cut), reason,
      });
    }
  } else if (detrain) {
    const reason = `You're fresh (form +${signals.tsb.toFixed(0)}) and load has dipped (ACWR ${signals.acwr.toFixed(2)}) — room to add a little.`;
    const sorted = [...upcoming].sort((a, b) => (a.targetLoad || 0) - (b.targetLoad || 0));
    const s = sorted[Math.floor(sorted.length / 2)];
    if (s) changes.push({
      id: s.id, kind: 'increase', title: s.title || cap(s.sport), sport: s.sport, date: s.date,
      fromLoad: s.targetLoad || 0, toLoad: Math.round((s.targetLoad || 0) * 1.15),
      toDurationSec: Math.round((s.targetDurationSec || 0) * 1.15), reason,
    });
  }
  return { state: overload ? 'overload' : detrain ? 'detrain' : 'ontrack', changes, signals };
}

export function applyAdaptation(plan, changes) {
  const map = new Map(changes.map(c => [c.id, c]));
  const sessions = (plan.sessions || []).map(s => {
    const c = map.get(s.id);
    if (!c) return s;
    return { ...s, targetLoad: c.toLoad, targetDurationSec: c.toDurationSec, adapted: c.kind };
  });
  return { ...plan, sessions };
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
