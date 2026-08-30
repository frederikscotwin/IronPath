// aicoach.js — the in-app AI coach.
// -----------------------------------------------------------------------------
// Engine-agnostic: talks to any OpenAI-compatible chat endpoint (OpenAI,
// OpenRouter, Groq, a local Ollama/LM Studio server, or Anthropic's compat
// endpoint), and the same message flow drives the on-device WebLLM engine.
// The coach can propose changes to your journal, daily wellness, plan and
// thresholds via a structured actions block that YOU approve before anything
// is written. Nothing here calls the network except chatCloud().
// -----------------------------------------------------------------------------

import { performanceChart, weeklyVolume, activityLoad, weightTrend, plannedDailyLoads } from './model.js';
import { estimateThresholds, predict } from './estimate.js';
import { fatigueSignals, dailyReadiness, modifierState } from './adapt.js';
import { newSession, mondayOf } from './plan.js';

const pace = (secPerUnit) => { if (!secPerUnit || !isFinite(secPerUnit)) return null; const m = Math.floor(secPerUnit / 60), s = Math.round(secPerUnit % 60); return `${m}:${String(s).padStart(2, '0')}`; };

// ---- compact context the model sees each turn -------------------------------
export function buildContext(state) {
  const { activities, settings, plan, weights, tests, wellness, journal, modifiers } = state;
  const pmc = performanceChart(activities, settings, { weights, plannedDaily: plannedDailyLoads(plan, settings) });
  const today = pmc.filter(p => !p.isFuture).slice(-1)[0] || null;
  const est = estimateThresholds(activities, tests, settings);
  const sig = fatigueSignals(pmc);
  const wt = weightTrend(weights);
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayWellness = (wellness || []).find(w => w.date === todayKey) || null;
  const mods = modifierState(modifiers, todayKey);
  const readiness = dailyReadiness(sig, wt, settings, todayWellness, mods);
  const pred = predict(activities, settings, weights, tests, pmc, est);

  return {
    today: todayKey,
    goal: settings.raceName || 'Ironman (base building)',
    raceDate: settings.raceDate || null,
    current: today ? { fitnessCTL: +today.ctl.toFixed(1), fatigueATL: +today.atl.toFixed(1), formTSB: +today.tsb.toFixed(1) } : null,
    fatigueSignals: sig ? { acwr: +sig.acwr.toFixed(2), monotony: +sig.monotony.toFixed(2) } : null,
    readiness: { score: readiness.score, reasons: readiness.reasons },
    activeRecovery: mods.active.map(a => ({ id: a.id, type: a.type, severity: a.severity, dayOf: a.dayOf, totalDays: a.totalDays, note: a.note })),
    formAdjustPoints: mods.points,
    weightKg: wt.smooth ? +wt.smooth.toFixed(1) : null,
    thresholds: {
      maxHr: settings.maxHr, restHr: settings.restHr, lthr: est.lthr.value,
      cssPacePer100m: est.cssSpeed.value ? pace(100 / est.cssSpeed.value) : null,
      runThresholdPacePerKm: est.runThresholdSpeed.value ? pace(1000 / est.runThresholdSpeed.value) : null,
      ctlDays: settings.ctlDays, atlDays: settings.atlDays,
    },
    predictedIronman: pred.ironman ? { total: Math.round(pred.ironman.total / 60) + ' min' } : null,
    last14Days: pmc.filter(p => !p.isFuture).slice(-14).map(p => ({ date: p.day, load: Math.round(p.load), tsb: +p.tsb.toFixed(0), sport: Object.keys(p.bySport || {}).join('+') || null })),
    weeklyVolume: weeklyVolume(activities, settings).slice(-6).map(w => ({ week: w.weekStart, hours: +w.hours.toFixed(1) })),
    upcomingPlan: (plan.sessions || []).filter(s => s.date >= todayKey).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 14)
      .map(s => ({ id: s.id, date: s.date, sport: s.sport, title: s.title, targetMin: Math.round((s.targetDurationSec || 0) / 60), targetLoad: s.targetLoad })),
    recentWellness: (wellness || []).slice(-7),
    recentJournal: (journal || []).slice(0, 8).map(j => ({ date: j.date, text: j.text, source: j.source })),
  };
}

// ---- system prompt + message assembly ---------------------------------------
export function systemPrompt(settings) {
  const scopes = settings.aiScopes || {};
  const allowed = Object.entries(scopes).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
  return `You are IronPath Coach, an expert triathlon coach embedded in the athlete's own training app. You are knowledgeable, direct, and encouraging, and you ground every statement in the JSON context you are given (fitness = CTL, fatigue = ATL, form = TSB; load is a training-stress number). Keep replies concise and practical.

The athlete is training for an Ironman. When they tell you how they feel or ask you to change something, you may propose changes to their data — but ONLY within these allowed areas: ${allowed}. You never invent numbers that aren't supported by the context.

To propose changes, end your reply with a fenced code block labelled ironpath-actions containing a JSON array. Use it ONLY when a concrete change is warranted; otherwise omit it. Supported actions:
- {"type":"add_journal","date":"YYYY-MM-DD","text":"...","tags":["optional"]}
- {"type":"set_wellness","date":"YYYY-MM-DD","fatigue":1-10,"sleep":hoursNumber,"soreness":1-10,"stress":1-10,"note":"..."}  (include only the fields you know; fatigue 10 = exhausted)
- {"type":"adjust_session","id":"<planSessionId>","targetLoadPct":0.6,"targetMinutes":45,"title":"..."}  (id from upcomingPlan; targetLoadPct scales the planned load; include only fields you change)
- {"type":"add_session","date":"YYYY-MM-DD","sport":"swim|bike|run|strength","title":"...","targetMinutes":60,"reserve":0.65}
- {"type":"suggest_threshold","field":"maxHr|restHr|lthr|ctlDays|atlDays|cssPacePer100mSec|runThresholdPacePerKmSec","value":number}
- {"type":"set_modifier","modifierType":"illness|injury|stress|travel|fatigue_offset","date":"YYYY-MM-DD","severity":1-10,"durationDays":N,"note":"..."}  (a recovery/impact event whose duration you judge; it starts at full strength and decays to zero across durationDays, lowering effective form and readiness and easing the plan. Use fatigue_offset when the athlete feels worse — or better — than the model shows)
- {"type":"clear_modifier","id":"<id from context.activeRecovery>"}

Judgement and follow-ups: if you're missing a detail needed to size a change well (days ill, severity, fever, hours slept), ask ONE short follow-up question and do NOT emit an actions block until you have it. When the athlete reports illness or injury, set a set_modifier with a sensible recovery window you judge (rough guide: mild cold ~4–7 days, flu ~10–14, a muscle strain often longer) and revise or clear it as they update you. Fitness (CTL) is computed from real training and is never set directly — you influence it only through the plan, thresholds/constants, and these modifiers.

Every action is shown to the athlete for approval before it is applied, so propose confidently but explain your reasoning in the reply text. Example ending:
\`\`\`ironpath-actions
[{"type":"set_wellness","date":"2026-08-30","fatigue":8,"sleep":5},{"type":"adjust_session","id":"p123","targetLoadPct":0.6}]
\`\`\``;
}

export function buildMessages(context, history, userMessage, settings) {
  const msgs = [{ role: 'system', content: systemPrompt(settings) }];
  msgs.push({ role: 'system', content: 'Current athlete context (JSON):\n' + JSON.stringify(context) });
  for (const m of (history || [])) msgs.push({ role: m.role, content: m.content });
  msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

// ---- cloud call (OpenAI-compatible) -----------------------------------------
export async function chatCloud(settings, messages) {
  const base = (settings.aiBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Set an AI endpoint URL in Setup → AI coach.');
  if (!settings.aiModel) throw new Error('Set an AI model name in Setup → AI coach.');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.aiApiKey) headers['Authorization'] = `Bearer ${settings.aiApiKey}`;
  if (base.includes('api.anthropic.com')) { headers['anthropic-dangerous-direct-browser-access'] = 'true'; headers['anthropic-version'] = '2023-06-01'; if (settings.aiApiKey) headers['x-api-key'] = settings.aiApiKey; }
  const res = await fetch(base + '/chat/completions', {
    method: 'POST', headers,
    body: JSON.stringify({ model: settings.aiModel, messages, temperature: 0.4, stream: false }),
  });
  if (!res.ok) {
    let msg = `AI endpoint error ${res.status}`;
    try { const e = await res.json(); msg += ': ' + (e.error?.message || JSON.stringify(e).slice(0, 200)); } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? '';
}

// ---- parse the actions block ------------------------------------------------
export function parseActions(text) {
  const re = /```ironpath-actions\s*([\s\S]*?)```/i;
  const m = text.match(re);
  let actions = [];
  if (m) {
    try { const parsed = JSON.parse(m[1].trim()); if (Array.isArray(parsed)) actions = parsed; }
    catch { /* leave empty on malformed JSON */ }
  }
  const reply = text.replace(re, '').trim();
  return { reply, actions };
}

// ---- describe (for the approval UI) -----------------------------------------
export function describeActions(actions, state) {
  const scopes = state.settings.aiScopes || {};
  const scopeOf = { add_journal: 'journal', set_wellness: 'wellness', adjust_session: 'plan', add_session: 'plan', suggest_threshold: 'thresholds', set_modifier: 'recovery', clear_modifier: 'recovery' };
  const out = [];
  for (const a of (actions || [])) {
    const scope = scopeOf[a.type];
    if (!scope || !scopes[scope]) { out.push({ blocked: true, type: a.type, summary: `Skipped ${a.type} (not permitted in Setup)` }); continue; }
    if (a.type === 'add_journal') out.push({ type: a.type, summary: `Add journal entry (${a.date || 'today'})`, detail: a.text });
    else if (a.type === 'set_wellness') out.push({ type: a.type, summary: `Log wellness (${a.date || 'today'})`, detail: ['fatigue', 'sleep', 'soreness', 'stress'].filter(k => a[k] != null).map(k => `${k} ${a[k]}`).join(', ') });
    else if (a.type === 'adjust_session') {
      const s = (state.plan.sessions || []).find(x => x.id === a.id);
      const from = s ? s.targetLoad : '?';
      const to = s && a.targetLoadPct != null ? Math.round((s.targetLoad || 0) * a.targetLoadPct) : (a.targetLoad ?? from);
      out.push({ type: a.type, summary: `Adjust ${s ? (s.title || s.sport) + ' ' + s.date.slice(5) : a.id}`, detail: `load ${from} → ${to}${a.title ? `, title "${a.title}"` : ''}` });
    } else if (a.type === 'add_session') out.push({ type: a.type, summary: `Add ${a.sport} session ${a.date}`, detail: `${a.title || ''} · ${a.targetMinutes || '?'} min` });
    else if (a.type === 'suggest_threshold') out.push({ type: a.type, summary: `Set ${a.field}`, detail: `→ ${a.value}` });
    else if (a.type === 'set_modifier') out.push({ type: a.type, summary: `Log ${a.modifierType} (${a.date || 'today'})`, detail: `severity ${a.severity}/10, ~${a.durationDays} days${a.note ? ' — ' + a.note : ''}` });
    else if (a.type === 'clear_modifier') out.push({ type: a.type, summary: `Clear recovery event`, detail: a.id });
    else out.push({ blocked: true, type: a.type, summary: `Unknown action ${a.type}` });
  }
  return out;
}

// ---- apply (only after approval) --------------------------------------------
// Pure-ish: returns the mutated plan/settings and lists of wellness/journal
// upserts for the caller to persist. Respects scopes.
export function applyActions(actions, state) {
  const scopes = state.settings.aiScopes || {};
  let plan = { ...state.plan, sessions: [...(state.plan.sessions || [])] };
  let settings = { ...state.settings };
  const wellnessUpserts = [];
  const journalAdds = [];
  const modifierUpserts = [];
  const modifierDeletes = [];
  const summary = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const a of (actions || [])) {
    if (a.type === 'add_journal' && scopes.journal) {
      journalAdds.push({ id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: a.date || today, text: a.text || '', tags: a.tags || [], source: 'ai' });
      summary.push('journal entry added');
    } else if (a.type === 'set_wellness' && scopes.wellness) {
      const base = (state.wellness || []).find(w => w.date === (a.date || today)) || { date: a.date || today };
      const entry = { ...base };
      for (const k of ['fatigue', 'sleep', 'soreness', 'stress', 'mood', 'note']) if (a[k] != null) entry[k] = a[k];
      wellnessUpserts.push(entry);
      summary.push(`wellness logged (${entry.date})`);
    } else if (a.type === 'adjust_session' && scopes.plan) {
      plan.sessions = plan.sessions.map(s => {
        if (s.id !== a.id) return s;
        const n = { ...s };
        if (a.targetLoadPct != null) { n.targetLoad = Math.round((s.targetLoad || 0) * a.targetLoadPct); n.targetDurationSec = Math.round((s.targetDurationSec || 0) * a.targetLoadPct); }
        if (a.targetLoad != null) n.targetLoad = a.targetLoad;
        if (a.targetMinutes != null) n.targetDurationSec = a.targetMinutes * 60;
        if (a.title) n.title = a.title;
        n.adapted = 'ai';
        return n;
      });
      summary.push('plan session adjusted');
    } else if (a.type === 'add_session' && scopes.plan) {
      const s = newSession(a.date || today, a.sport || 'run');
      s.title = a.title || ''; s.targetDurationSec = (a.targetMinutes || 60) * 60; s.targetReserve = a.reserve ?? 0.65;
      plan.sessions.push(s);
      summary.push('plan session added');
    } else if (a.type === 'suggest_threshold' && scopes.thresholds) {
      const f = a.field, v = Number(a.value);
      if (['maxHr', 'restHr', 'lthr', 'ctlDays', 'atlDays'].includes(f)) settings[f] = v;
      else if (f === 'cssPacePer100mSec' && v > 0) settings.cssSpeed = 100 / v;
      else if (f === 'runThresholdPacePerKmSec' && v > 0) settings.runThresholdSpeed = 1000 / v;
      summary.push(`${f} set to ${v}`);
    } else if (a.type === 'set_modifier' && scopes.recovery) {
      const type = a.modifierType || 'fatigue_offset';
      modifierUpserts.push({ id: a.id || ('m' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), date: a.date || today, type, severity: Math.max(1, Math.min(10, Number(a.severity) || 5)), durationDays: Math.max(1, Number(a.durationDays) || 7), note: a.note || '', source: 'ai' });
      summary.push(`${type} logged`);
    } else if (a.type === 'clear_modifier' && scopes.recovery) {
      if (a.id) { modifierDeletes.push(a.id); summary.push('recovery event cleared'); }
    }
  }
  return { plan, settings, wellnessUpserts, journalAdds, modifierUpserts, modifierDeletes, summary };
}
