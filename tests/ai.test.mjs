import * as M from '../js/model.js';
import * as A from '../js/adapt.js';
import * as C from '../js/aicoach.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const approx = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

const settings = {
  maxHr: 190, restHr: 45, trimpB: 1.92, ctlDays: 42, atlDays: 7, tsbDeepFatigue: -25,
  acwrHigh: 1.5, acwrLow: 0.8, monotonyHigh: 2.5, adaptHorizonDays: 7, adaptCutPct: 0.6,
  aiSubjectiveWeight: 1, aiScopes: { journal: true, wellness: true, plan: true, thresholds: true },
  defaultReserveBySport: { swim: 0.7, bike: 0.65, run: 0.72, strength: 0.5, other: 0.6 },
  rpeToReserve: { base: 0.4, slope: 0.05 }, cssSpeed: 1.0, runThresholdSpeed: 3.7,
};

console.log('parseActions');
const txt = `Sounds like a rough night. I'll ease your week.\n\n\`\`\`ironpath-actions\n[{"type":"set_wellness","date":"2026-08-30","fatigue":8,"sleep":5},{"type":"adjust_session","id":"p1","targetLoadPct":0.6}]\n\`\`\``;
const parsed = C.parseActions(txt);
ok('extracts 2 actions', parsed.actions.length === 2, JSON.stringify(parsed.actions));
ok('reply strips the actions block', !parsed.reply.includes('ironpath-actions') && parsed.reply.startsWith('Sounds'));
ok('malformed json -> no actions but block removed', (() => { const p = C.parseActions('hi\n```ironpath-actions\n{bad json}\n```'); return p.actions.length === 0 && !p.reply.includes('ironpath-actions'); })());
ok('no block -> plain reply', (() => { const p = C.parseActions('just chatting'); return p.actions.length === 0 && p.reply === 'just chatting'; })());

console.log('applyActions');
const state = {
  settings,
  plan: { phases: [], sessions: [{ id: 'p1', date: '2026-09-01', sport: 'bike', title: 'Long ride', targetLoad: 200, targetDurationSec: 9000, targetReserve: 0.6 }] },
  wellness: [], journal: [], activities: [], weights: [], tests: [],
};
const res = C.applyActions(parsed.actions, state);
ok('wellness upsert created', res.wellnessUpserts.length === 1 && res.wellnessUpserts[0].fatigue === 8 && res.wellnessUpserts[0].sleep === 5);
ok('session load scaled 200 -> 120', res.plan.sessions.find(s => s.id === 'p1').targetLoad === 120, JSON.stringify(res.plan.sessions[0]));
ok('session marked ai-adapted', res.plan.sessions.find(s => s.id === 'p1').adapted === 'ai');

const res2 = C.applyActions([
  { type: 'add_journal', date: '2026-08-30', text: 'Felt strong today' },
  { type: 'add_session', date: '2026-09-03', sport: 'run', title: 'Easy run', targetMinutes: 40 },
  { type: 'suggest_threshold', field: 'maxHr', value: 188 },
  { type: 'suggest_threshold', field: 'cssPacePer100mSec', value: 100 },
], state);
ok('journal add captured with ai source', res2.journalAdds.length === 1 && res2.journalAdds[0].source === 'ai');
ok('plan session added', res2.plan.sessions.length === 2);
ok('threshold maxHr applied', res2.settings.maxHr === 188);
ok('css pace 100s/100m -> speed 1.0 m/s', approx(res2.settings.cssSpeed, 1.0, 1e-9), res2.settings.cssSpeed);

console.log('scope gating');
const locked = { ...state, settings: { ...settings, aiScopes: { journal: true, wellness: false, plan: false, thresholds: false } } };
const res3 = C.applyActions(parsed.actions, locked);
ok('wellness blocked when scope off', res3.wellnessUpserts.length === 0);
ok('plan blocked when scope off', res3.plan.sessions.find(s => s.id === 'p1').targetLoad === 200);
const desc = C.describeActions(parsed.actions, locked);
ok('describeActions marks blocked', desc.some(d => d.blocked));

console.log('describeActions (allowed)');
const desc2 = C.describeActions(parsed.actions, state);
ok('describes wellness + adjust', desc2.length === 2 && desc2[0].summary.includes('wellness') && desc2[1].summary.includes('Long ride'), JSON.stringify(desc2));

console.log('wellness -> readiness + adaptation');
const sig = { tsb: 0, ctl: 60, atl: 60, acwr: 1.0, monotony: 1.5, acute7: 500 };
const rHealthy = A.dailyReadiness(sig, { dropPct7: 0 }, settings, null);
const rTired = A.dailyReadiness(sig, { dropPct7: 0 }, settings, { fatigue: 9, sleep: 5 });
ok('reported fatigue lowers readiness', rTired.score < rHealthy.score, `${rTired.score} vs ${rHealthy.score}`);
ok('readiness reason mentions fatigue', rTired.reasons.some(r => /fatigue/i.test(r)));
const plan = { sessions: [{ id: 'p1', date: M.addDays(M.dayKey(new Date()), 1), sport: 'bike', title: 'Long', targetLoad: 200, targetDurationSec: 9000 }] };
const adaptNoWell = A.adaptationSuggestions(plan, sig, settings, null);
const adaptTired = A.adaptationSuggestions(plan, sig, settings, { fatigue: 9 });
ok('no adaptation when not overloaded + no subjective', adaptNoWell.state === 'ontrack');
ok('high reported fatigue triggers adaptation', adaptTired.state === 'overload' && adaptTired.changes.length > 0);

console.log('buildContext smoke');
const ctx = C.buildContext({ activities: [{ sport: 'run', durationSec: 3600, avgHr: 150, startTime: M.dayKey(new Date()) + 'T09:00' }], settings, plan: { phases: [], sessions: [] }, weights: [{ date: M.dayKey(new Date()), kg: 78 }], tests: [], wellness: [{ date: new Date().toISOString().slice(0,10), fatigue: 4 }], journal: [] });
ok('context has readiness + thresholds + last14Days', ctx.readiness && ctx.thresholds && Array.isArray(ctx.last14Days));

console.log('systemPrompt reflects scopes');
ok('prompt lists allowed scopes', C.systemPrompt(settings).includes('journal') && C.systemPrompt(locked.settings).includes('journal') && !C.systemPrompt({ aiScopes: { journal:false, wellness:false, plan:false, thresholds:false } }).includes('journal, '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
