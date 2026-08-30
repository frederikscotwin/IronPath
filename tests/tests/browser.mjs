import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright/index.js');
import http from 'http';
import { readFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';

const ROOT = path.resolve('.');
const PORT = 8199;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    if (p.startsWith('/mock/')) {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const today = new Date().toISOString().slice(0, 10);
        // Branch on the athlete's LAST user message (not the whole payload — the
        // system prompt itself mentions "illness"), to exercise different actions.
        let lastUser = '';
        try { const j = JSON.parse(body); lastUser = [...(j.messages || [])].reverse().find(m => m.role === 'user')?.content || ''; } catch {}
        const isIllness = /flu|sick|fever/i.test(lastUser);
        const content = isIllness
          ? "Sorry you're under the weather — rest is the priority. I'll log it with a recovery window and ease the plan; update me as it changes.\n\n```ironpath-actions\n[{\"type\":\"set_modifier\",\"modifierType\":\"illness\",\"date\":\"" + today + "\",\"severity\":7,\"durationDays\":12,\"note\":\"flu\"}]\n```"
          : "Got it — noting that and easing off.\n\n```ironpath-actions\n[{\"type\":\"add_journal\",\"date\":\"" + today + "\",\"text\":\"AI test note\"}]\n```";
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      });
      return;
    }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => server.listen(PORT, r));

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 }, colorScheme: 'dark' });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tabbar', { timeout: 5000 });

// import all sample files
const dir = path.join(ROOT, 'tests/samples');
const files = readdirSync(dir).map(f => path.join(dir, f));
await page.setInputFiles('#fileInput', files);
await page.waitForTimeout(1500);

// seed weights, benchmark tests, race date + age directly into IndexedDB
await page.evaluate(async (mockBase) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ironpath'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  // 90 days of weight, gently declining 80.5 -> 78.6
  const today = new Date();
  const wtx = db.transaction('weights', 'readwrite').objectStore('weights');
  for (let i = 90; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const kg = 80.5 - (90 - i) / 90 * 1.9 + (Math.sin(i) * 0.15);
    wtx.put({ date, kg: +kg.toFixed(1) });
  }
  const ttx = db.transaction('tests', 'readwrite').objectStore('tests');
  ttx.put({ id: 'Tcss', type: 'swim_css', date: today.toISOString().slice(0, 10), t400: 380, t200: 185 });
  ttx.put({ id: 'Trun', type: 'run_tt20', date: today.toISOString().slice(0, 10), distanceM: 4600, avgHr: 176 });
  // settings: race date ~7 months out + age
  const race = new Date(today); race.setMonth(race.getMonth() + 7);
  const stx = db.transaction('meta', 'readwrite').objectStore('meta');
  await new Promise(r => { const g = stx.get('settings'); g.onsuccess = () => {
    const s = (g.result && g.result.value) || {};
    s.raceDate = race.toISOString().slice(0, 10); s.raceName = 'Ironman Copenhagen'; s.age = 34;
    s.loadBasis = 'combined'; s.energyBlend = 0.5;
    s.aiEngine = 'cloud'; s.aiBaseUrl = mockBase; s.aiModel = 'mock';
    s.aiScopes = { journal: true, wellness: true, plan: true, thresholds: true, recovery: true };
    db.transaction('meta', 'readwrite').objectStore('meta').put({ key: 'settings', value: s });
    r();
  }; });
}, `http://localhost:${PORT}/mock`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.tabbar');
await page.waitForTimeout(600);

const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `tests/shot_${name}.png` }); };
async function tab(name) { await page.click(`.tab[data-tab="${name}"]`); await page.waitForTimeout(500); }

const hasReadyChip = await page.locator('text=Readiness').count();
await shot('home');

await tab('coach');
const hasPred = await page.locator('text=Ironman finish projection').count();
const hasReady = await page.locator('text=Race readiness').count();
const hasCal = await page.locator('text=Self-calibrating').count();
const hasEst = await page.locator('text=Estimated from your history').count();
const hasBest = await page.locator('text=Best efforts').count();
const hasRace = await page.locator('text=Race-day plan').count();
const hasDur = await page.locator('text=Durability').count();
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.screenshot({ path: 'tests/shot_coach_full.png', fullPage: true });
await page.evaluate(() => window.scrollTo(0, 0));

// Plan: generate, adaptation card, taper, workout export
await tab('plan');
await page.click('[data-action="genPlan"]').catch(() => {});
await page.waitForTimeout(700);
const hasAdapt = await page.locator('text=Plan on track, text=Plan adaptation').count()
  + await page.locator('text=Plan on track').count() + await page.locator('text=adaptation').count();
await page.click('[data-action="genTaper"]').catch(() => {});
await page.waitForTimeout(500);
const hasTaper = await page.locator('.week:has-text("")').count(); // weeks rendered
await page.screenshot({ path: 'tests/shot_plan.png' });
// open a workout modal
await page.click('[data-action="exportWorkout"]').catch(() => {});
await page.waitForTimeout(400);
const hasWorkoutModal = await page.locator('.modal:has-text("Garmin workout")').count();
await page.screenshot({ path: 'tests/shot_workout.png' });
await page.locator('#wk_close').click().catch(() => {});

await tab('log'); await shot('log');
await tab('stats');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await shot('stats');
await page.click('#gearBtn'); await page.waitForTimeout(300);
const hasAutoReg = await page.locator('text=Auto-regulation').count();
// wellness check-in
await tab('log');
await page.fill('#wl_fatigue', '8').catch(() => {});
await page.click('[data-action="saveWellness"]').catch(() => {});
await page.waitForTimeout(300);
const readinessAfterWellness = await (async () => { await tab('home'); return page.locator('text=high fatigue').count(); })();

// AI chat -> propose -> approve (via mock endpoint)
await tab('ai');
const aiOk = await page.evaluate(() => !!window.__ai && window.__ai.prompt.includes('self-calibrating') && !!window.__ai.payload.raceDayPlan);
await page.fill('#chatInput', 'Slept badly, legs are toast, ease this week.');
await page.click('[data-action="sendChat"]');
await page.waitForTimeout(1000);
const hasAssistant = await page.locator('.chat-msg.assistant').count();
const hasProposed = await page.locator('text=Proposed changes').count();
await page.screenshot({ path: 'tests/shot_ai_chat.png' });
await page.click('[data-action="approveActions"]').catch(() => {});
await page.waitForTimeout(400);
const journalHasAi = await page.locator('.pill:has-text("AI")').count();

// AI recovery modifier: report illness -> coach proposes set_modifier -> approve
await tab('ai');
await page.fill('#chatInput', "I've come down with the flu, feeling awful.");
await page.click('[data-action="sendChat"]');
await page.waitForTimeout(1000);
const proposedMod = await page.locator('text=Log illness').count();
await page.screenshot({ path: 'tests/shot_ai_illness.png' });
await page.click('[data-action="approveActions"]').catch(() => {});
await page.waitForTimeout(400);
// modifier persisted?
const nMods = await page.evaluate(async () => {
  const db = await new Promise(res => { const r = indexedDB.open('ironpath'); r.onsuccess = () => res(r.result); });
  return await new Promise(res => { const tx = db.transaction('modifiers').objectStore('modifiers').getAll(); tx.onsuccess = () => res(tx.result.length); });
});
// home shows the recovery card + the status feeds the "what the model is telling you" section
await tab('home');
const recoveryCard = await page.locator('text=Recovery & adjustments').count();
const statusRecovering = await page.locator('text=Recovering from illness').count();
await page.screenshot({ path: 'tests/shot_home_recovery.png' });
// clear it from the home card
await page.click('[data-action="delModifier"]').catch(() => {});
await page.waitForTimeout(400);
const nModsAfterClear = await page.evaluate(async () => {
  const db = await new Promise(res => { const r = indexedDB.open('ironpath'); r.onsuccess = () => res(r.result); });
  return await new Promise(res => { const tx = db.transaction('modifiers').objectStore('modifiers').getAll(); tx.onsuccess = () => res(tx.result.length); });
});

const nSess = await page.evaluate(async () => {
  const db = await new Promise(res => { const r = indexedDB.open('ironpath'); r.onsuccess = () => res(r.result); });
  return await new Promise(res => { const tx = db.transaction('activities').objectStore('activities').getAll(); tx.onsuccess = () => res(tx.result.length); });
});

console.log('sessions:', nSess, '| readiness chip:', !!hasReadyChip);
console.log('coach: predictions', !!hasPred, '| readiness', !!hasReady, '| calibration', !!hasCal, '| estimates', !!hasEst, '| best-efforts', !!hasBest, '| race-day', !!hasRace, '| durability', !!hasDur);
console.log('plan: adaptation card', !!hasAdapt, '| taper weeks rendered', hasTaper, '| workout modal', !!hasWorkoutModal);
console.log('setup auto-regulation card:', !!hasAutoReg);
console.log('AI export has raceDayPlan + new fields:', aiOk);
console.log('wellness->readiness reason shown:', !!readinessAfterWellness);
console.log('AI chat: assistant reply', !!hasAssistant, '| proposed-changes card', !!hasProposed, '| applied AI journal entry', !!journalHasAi);
console.log('AI recovery: proposed set_modifier', !!proposedMod, '| persisted', nMods, '| home recovery card', !!recoveryCard, '| status "Recovering"', !!statusRecovering, '| cleared ->', nModsAfterClear);
console.log('errors:', errors.length ? errors : 'none');

await browser.close();
server.close();
const failed = errors.length || nSess < 80 || !hasPred || !hasReady || !hasCal || !hasEst
  || !hasBest || !hasRace || !hasDur || !hasReadyChip || !hasWorkoutModal || !hasAutoReg || !aiOk
  || !hasAssistant || !hasProposed || !journalHasAi || !readinessAfterWellness
  || !proposedMod || nMods !== 1 || !recoveryCard || !statusRecovering || nModsAfterClear !== 0;
process.exit(failed ? 1 : 0);
