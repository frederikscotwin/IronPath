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
// `wellness` is today's self-reported entry ({fatigue 1-10, sleep hours,
// soreness 1-10, stress 1-10}) — what you feel, folded in alongside the model.
export function dailyReadiness(signals, weight, settings, wellness) {
  if (!signals) return { score: null, color: 'grey', reasons: ['No data yet'] };
  let score = 100;
  const reasons = [];
  if (signals.tsb < settings.tsbDeepFatigue) { score -= 35; reasons.push(`Form very low (${signals.tsb.toFixed(0)})`); }
  else if (signals.tsb < -10) { score -= 15; reasons.push(`Carrying fatigue (form ${signals.tsb.toFixed(0)})`); }
  if (signals.acwr > (settings.acwrHigh ?? 1.5)) { score -= 25; reasons.push(`Load spike (ACWR ${signals.acwr.toFixed(2)})`); }
  else if (signals.acwr && signals.acwr < (settings.acwrLow ?? 0.8) && signals.acute7 > 0) { score -= 8; reasons.push(`Load dropped (ACWR ${signals.acwr.toFixed(2)})`); }
  if (signals.monotony > (settings.monotonyHigh ?? 2.5)) { score -= 10; reasons.push(`High monotony (${signals.monotony.toFixed(1)})`); }
  if (weight && weight.dropPct7 > 1.5) { score -= 12; reasons.push(`Rapid weight loss (${weight.dropPct7.toFixed(1)}%/wk)`); }

  const sw = settings.aiSubjectiveWeight ?? 1;
  if (wellness && sw > 0) {
    if (Number.isFinite(wellness.fatigue)) {
      if (wellness.fatigue >= 7) { score -= Math.round((wellness.fatigue - 6) * 6 * sw); reasons.unshift(`You reported high fatigue (${wellness.fatigue}/10)`); }
      else if (wellness.fatigue <= 3) { reasons.unshift(`You reported feeling fresh (${wellness.fatigue}/10)`); }
    }
    if (Number.isFinite(wellness.sleep) && wellness.sleep < 6) { score -= Math.round(6 * sw); reasons.push(`Short sleep (${wellness.sleep}h)`); }
    if (Number.isFinite(wellness.soreness) && wellness.soreness >= 7) { score -= Math.round(5 * sw); reasons.push(`High soreness (${wellness.soreness}/10)`); }
  }

  score = clamp(Math.round(score), 0, 100);
  const color = score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red';
  if (!reasons.length) reasons.push('Fresh and balanced');
  return { score, color, reasons };
}

// ---- adaptation pass --------------------------------------------------------
function overloadReason(s, settings, wellness) {
  const bits = [];
  if (s.tsb < settings.tsbDeepFatigue) bits.push(`form ${s.tsb.toFixed(0)}`);
  if (s.acwr > (settings.acwrHigh ?? 1.5)) bits.push(`ACWR ${s.acwr.toFixed(2)}`);
  if (wellness && Number.isFinite(wellness.fatigue) && wellness.fatigue >= 8) bits.push(`reported fatigue ${wellness.fatigue}/10`);
  return `You're overreaching (${bits.join(', ')}) — easing the hardest upcoming sessions.`;
}

export function adaptationSuggestions(plan, signals, settings, wellness) {
  const today = dayKey(new Date());
  const horizon = addDays(today, settings.adaptHorizonDays ?? 7);
  const upcoming = (plan.sessions || []).filter(s => s.date >= today && s.date <= horizon && (s.targetLoad || 0) > 0);
  if (!signals || !upcoming.length) return { state: 'ontrack', changes: [], signals };

  // Overload cuts load on form/ACWR, or when you report very high fatigue today.
  // High monotony is an "add variety" nudge, not a reason to reduce volume.
  const highSubjective = wellness && Number.isFinite(wellness.fatigue) && wellness.fatigue >= 8;
  const overload = signals.tsb < settings.tsbDeepFatigue
    || signals.acwr > (settings.acwrHigh ?? 1.5)
    || highSubjective;
  const detrain = signals.tsb > (settings.tsbVeryFresh ?? 15)
    && signals.acwr && signals.acwr < (settings.acwrLow ?? 0.8) && signals.acute7 > 0;

  const changes = [];
  if (overload) {
    const cut = settings.adaptCutPct ?? 0.6;
    const reason = overloadReason(signals, settings, wellness);
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
