// modifiers.test.mjs — coach-set recovery/impact events (illness, injury,
// stress, travel, subjective offset): decay math, readiness + adaptation
// effects, and the set_modifier / clear_modifier action round-trip.
import * as M from '../js/model.js';
import * as A from '../js/adapt.js';
import * as C from '../js/aicoach.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

const settings = {
  maxHr: 190, restHr: 45, trimpB: 1.92, ctlDays: 42, atlDays: 7, tsbDeepFatigue: -25,
  acwrHigh: 1.5, acwrLow: 0.8, monotonyHigh: 2.5, adaptHorizonDays: 7, adaptCutPct: 0.6,
  aiSubjectiveWeight: 1,
  aiScopes: { journal: true, wellness: true, plan: true, thresholds: true, recovery: true },
  cssSpeed: 1.0, runThresholdSpeed: 3.7,
};

console.log('modifierState — decay math');
// illness, severity 6, 10-day window; weight(illness)=3 so full strength = 18 pts.
const ill = { id: 'm1', type: 'illness', date: '2026-08-20', severity: 6, durationDays: 10, note: 'flu' };
const d0 = A.modifierState([ill], '2026-08-20');
ok('day 0 full strength = severity*weight (18)', d0.points === 18, JSON.stringify(d0));
ok('day 0 dayOf = 1', d0.active[0].dayOf === 1);
ok('day 0 active reason mentions Illness', d0.reasons[0].includes('Illness') && d0.reasons[0].includes('day 1/10'));
const dMid = A.modifierState([ill], '2026-08-25'); // elapsed 5 -> decay 0.5 -> 9
ok('midpoint decays linearly to half (9)', dMid.points === 9, JSON.stringify(dMid));
ok('midpoint dayOf = 6', dMid.active[0].dayOf === 6);
const dEnd = A.modifierState([ill], '2026-08-30'); // elapsed 10 -> decay 0 -> 0, still listed
ok('end of window decays to 0 but still active', dEnd.points === 0 && dEnd.active.length === 1, JSON.stringify(dEnd));
const dPast = A.modifierState([ill], '2026-08-31'); // elapsed 11 -> dropped
ok('past window drops out entirely', dPast.points === 0 && dPast.active.length === 0);
const dFuture = A.modifierState([ill], '2026-08-19'); // elapsed -1 -> not yet
ok('before start not counted', dFuture.active.length === 0);

console.log('modifierState — multiple + weights');
const inj = { id: 'm2', type: 'injury', date: '2026-08-20', severity: 5, durationDays: 20 }; // 5*2.6=13
const both = A.modifierState([ill, inj], '2026-08-20');
ok('points sum across active modifiers (18+13=31)', both.points === 31, JSON.stringify(both));
ok('two active entries', both.active.length === 2);
const off = A.modifierState([{ id: 'm3', type: 'fatigue_offset', date: '2026-08-20', severity: 4, durationDays: 5 }], '2026-08-20');
ok('fatigue_offset weight 2.0 (4*2=8)', off.points === 8, JSON.stringify(off));

console.log('dailyReadiness folds in modifiers');
const sig = { tsb: 0, ctl: 60, atl: 60, acwr: 1.0, monotony: 1.5, acute7: 500 };
const rNone = A.dailyReadiness(sig, { dropPct7: 0 }, settings, null, null);
const rIll = A.dailyReadiness(sig, { dropPct7: 0 }, settings, null, d0);
ok('modifier lowers readiness score', rIll.score < rNone.score, `${rIll.score} vs ${rNone.score}`);
ok('modifier subtracts its points (capped 45)', rIll.score === rNone.score - Math.min(d0.points, 45), `${rIll.score}`);
ok('modifier reason surfaces first', /illness/i.test(rIll.reasons[0]), JSON.stringify(rIll.reasons));

console.log('adaptationSuggestions — active illness eases the plan');
const tomorrow = M.addDays(M.dayKey(new Date()), 1);
const plan = { sessions: [{ id: 'p1', date: tomorrow, sport: 'bike', title: 'Long ride', targetLoad: 200, targetDurationSec: 9000 }] };
const modsNowIll = A.modifierState([{ id: 'm1', type: 'illness', date: M.dayKey(new Date()), severity: 6, durationDays: 10 }], M.dayKey(new Date()));
const adaptNo = A.adaptationSuggestions(plan, sig, settings, null, null);
const adaptIll = A.adaptationSuggestions(plan, sig, settings, null, modsNowIll);
ok('healthy + no mods -> on track', adaptNo.state === 'ontrack', adaptNo.state);
ok('active illness (sev>=5) -> overload + cut', adaptIll.state === 'overload' && adaptIll.changes.length > 0, JSON.stringify(adaptIll.changes));
ok('cut reason names the illness', /illness/i.test(adaptIll.changes[0].reason), adaptIll.changes[0].reason);
ok('cut lowers the load', adaptIll.changes[0].toLoad < adaptIll.changes[0].fromLoad);
// A mild fatigue_offset that is not illness/injury should NOT force a cut on its own
const mildOff = A.modifierState([{ id: 'm3', type: 'fatigue_offset', date: M.dayKey(new Date()), severity: 3, durationDays: 5 }], M.dayKey(new Date()));
const adaptMild = A.adaptationSuggestions(plan, sig, settings, null, mildOff);
ok('mild subjective offset alone -> still on track', adaptMild.state === 'ontrack', adaptMild.state);
// A big offset that pushes adjusted form below the deep-fatigue line SHOULD cut
const bigOff = A.modifierState([{ id: 'm4', type: 'fatigue_offset', date: M.dayKey(new Date()), severity: 10, durationDays: 5 }], M.dayKey(new Date()));
const sigLow = { tsb: -10, ctl: 60, atl: 70, acwr: 1.0, monotony: 1.5, acute7: 500 };
const adaptBig = A.adaptationSuggestions(plan, sigLow, settings, null, bigOff); // adjTsb = -10 - 20 = -30 < -25
ok('offset pushing adj-form below deep line -> overload', adaptBig.state === 'overload', `adjTsb path: ${adaptBig.state}`);

console.log('parse + apply set_modifier / clear_modifier');
const txt = `That flu needs real rest. I'll log it and ease the week.\n\n\`\`\`ironpath-actions\n[{"type":"set_modifier","modifierType":"illness","date":"2026-08-30","severity":7,"durationDays":12,"note":"flu, fever"}]\n\`\`\``;
const p = C.parseActions(txt);
ok('parses set_modifier action', p.actions.length === 1 && p.actions[0].type === 'set_modifier', JSON.stringify(p.actions));
const state = { settings, plan: { phases: [], sessions: [] }, wellness: [], journal: [], activities: [], weights: [], tests: [], modifiers: [] };
const applied = C.applyActions(p.actions, state);
ok('set_modifier produces one upsert', applied.modifierUpserts.length === 1, JSON.stringify(applied.modifierUpserts));
const up = applied.modifierUpserts[0];
ok('upsert carries type/severity/duration/note', up.type === 'illness' && up.severity === 7 && up.durationDays === 12 && up.note === 'flu, fever', JSON.stringify(up));
ok('upsert marked ai source + has id', up.source === 'ai' && !!up.id);
ok('severity clamped to 1..10', C.applyActions([{ type: 'set_modifier', modifierType: 'stress', severity: 99, durationDays: 3 }], state).modifierUpserts[0].severity === 10);
ok('duration 0/omitted falls back to default (7)', C.applyActions([{ type: 'set_modifier', modifierType: 'stress', severity: 4, durationDays: 0 }], state).modifierUpserts[0].durationDays === 7);
ok('negative duration floored to >=1', C.applyActions([{ type: 'set_modifier', modifierType: 'stress', severity: 4, durationDays: -3 }], state).modifierUpserts[0].durationDays === 1);
const cleared = C.applyActions([{ type: 'clear_modifier', id: 'm9' }], state);
ok('clear_modifier queues a delete', cleared.modifierDeletes.length === 1 && cleared.modifierDeletes[0] === 'm9');

console.log('scope gating (recovery)');
const locked = { ...state, settings: { ...settings, aiScopes: { journal: true, wellness: true, plan: true, thresholds: true, recovery: false } } };
const blocked = C.applyActions(p.actions, locked);
ok('set_modifier blocked when recovery scope off', blocked.modifierUpserts.length === 0);
const dLock = C.describeActions(p.actions, locked);
ok('describeActions flags blocked recovery action', dLock[0].blocked === true, JSON.stringify(dLock));
const dOpen = C.describeActions(p.actions, state);
ok('describeActions summarizes set_modifier', dOpen[0].summary.includes('illness') && dOpen[0].detail.includes('severity'), JSON.stringify(dOpen));
const dClear = C.describeActions([{ type: 'clear_modifier', id: 'm9' }], state);
ok('describeActions summarizes clear_modifier', dClear[0].summary.toLowerCase().includes('clear'), JSON.stringify(dClear));

console.log('buildContext exposes recovery state');
const ctx = C.buildContext({
  activities: [{ sport: 'run', durationSec: 3600, avgHr: 150, startTime: M.dayKey(new Date()) + 'T09:00' }],
  settings, plan: { phases: [], sessions: [] }, weights: [{ date: M.dayKey(new Date()), kg: 78 }],
  tests: [], wellness: [], journal: [],
  modifiers: [{ id: 'm1', type: 'illness', date: M.dayKey(new Date()), severity: 6, durationDays: 10 }],
});
ok('context.activeRecovery lists the modifier with id', Array.isArray(ctx.activeRecovery) && ctx.activeRecovery.length === 1 && ctx.activeRecovery[0].id === 'm1', JSON.stringify(ctx.activeRecovery));
ok('context.formAdjustPoints > 0 while active', ctx.formAdjustPoints > 0, `${ctx.formAdjustPoints}`);
ok('readiness in context already reflects the knock-down', ctx.readiness.reasons.some(r => /illness/i.test(r)), JSON.stringify(ctx.readiness));

console.log('systemPrompt advertises modifier actions when recovery scoped');
const sp = C.systemPrompt(settings);
ok('prompt documents set_modifier', sp.includes('set_modifier') && sp.includes('illness'));
ok('prompt tells model CTL is never set directly', /never set directly/i.test(sp));
ok('prompt invites one follow-up question', /follow-up/i.test(sp) || /one short follow/i.test(sp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
