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
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tabbar', { timeout: 5000 });

// import all sample files
const dir = path.join(ROOT, 'tests/samples');
const files = readdirSync(dir).map(f => path.join(dir, f));
await page.setInputFiles('#fileInput', files);
await page.waitForTimeout(1500);

const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `tests/shot_${name}.png` }); };

await shot('home');

// verify tiles rendered with numbers
const fitness = await page.textContent('.tile.fitness .v').catch(() => null);
const nSess = await page.evaluate(async () => {
  const req = indexedDB.open('ironpath');
  return await new Promise(res => { req.onsuccess = () => { const db = req.result;
    const tx = db.transaction('activities').objectStore('activities').getAll();
    tx.onsuccess = () => res(tx.result.length); }; });
});

async function tab(name) { await page.click(`.tab[data-tab="${name}"]`); await page.waitForTimeout(400); }

await tab('log'); await shot('log');
await tab('stats'); await shot('stats');
await tab('plan');
await page.click('[data-action="genPlan"]').catch(() => {});
await page.waitForTimeout(600); await shot('plan');
await tab('ai'); await shot('ai');
await tab('setup'); await shot('setup');

// exercise the AI export builder + a manual add via model in page
const aiOk = await page.evaluate(() => !!window.__ai && window.__ai.prompt.includes('IronPath'));

console.log('sessions imported:', nSess);
console.log('fitness tile:', fitness);
console.log('ai payload ok:', aiOk);
console.log('errors:', errors.length ? errors : 'none');

await browser.close();
server.close();
process.exit(errors.length || nSess < 80 || !fitness ? 1 : 0);
