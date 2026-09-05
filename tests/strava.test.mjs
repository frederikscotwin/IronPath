// strava.test.mjs — hands-off token refresh: the pure refresh-decision helper
// and the serverless-proxy exchange (with a mocked fetch).
import { stravaNeedsRefresh, refreshViaProxy, mapStravaActivity } from '../js/strava.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const NOW = 1_700_000_000; // fixed "now" in epoch seconds

console.log('stravaNeedsRefresh');
ok('no proxy configured -> never refresh (manual token left alone)',
  stravaNeedsRefresh({ stravaAccessToken: 'abc' }, NOW) === false);
ok('proxy but no refresh token -> no refresh',
  stravaNeedsRefresh({ stravaProxyUrl: 'https://x/api', stravaTokenExpiry: 0 }, NOW) === false);
ok('proxy + refresh token, token expired -> refresh',
  stravaNeedsRefresh({ stravaProxyUrl: 'https://x/api', stravaRefreshToken: 'r', stravaTokenExpiry: NOW - 10 }, NOW) === true);
ok('proxy + refresh token, no expiry yet -> refresh',
  stravaNeedsRefresh({ stravaProxyUrl: 'https://x/api', stravaRefreshToken: 'r', stravaTokenExpiry: 0 }, NOW) === true);
ok('token valid well into the future -> no refresh',
  stravaNeedsRefresh({ stravaProxyUrl: 'https://x/api', stravaRefreshToken: 'r', stravaTokenExpiry: NOW + 3600 }, NOW) === false);
ok('token inside the 2-min grace window -> refresh early',
  stravaNeedsRefresh({ stravaProxyUrl: 'https://x/api', stravaRefreshToken: 'r', stravaTokenExpiry: NOW + 60 }, NOW) === true);
ok('token just past the grace window -> still valid',
  stravaNeedsRefresh({ stravaProxyUrl: 'https://x/api', stravaRefreshToken: 'r', stravaTokenExpiry: NOW + 121 }, NOW) === false);

console.log('refreshViaProxy (mocked fetch)');
let captured = null;
globalThis.fetch = async (url, opts) => {
  captured = { url, opts };
  return { ok: true, json: async () => ({ access_token: 'fresh_at', refresh_token: 'rotated_rt', expires_at: NOW + 21600, extra: 'ignored' }) };
};
const r = await refreshViaProxy('https://x/api/strava-oauth', 'old_rt');
ok('POSTs to the proxy URL', captured.url === 'https://x/api/strava-oauth' && captured.opts.method === 'POST');
ok('sends grant_type=refresh_token + the refresh token', (() => { const b = JSON.parse(captured.opts.body); return b.grant_type === 'refresh_token' && b.refresh_token === 'old_rt'; })(), captured.opts.body);
ok('returns the fresh access token + rotated refresh token + expiry', r.access_token === 'fresh_at' && r.refresh_token === 'rotated_rt' && r.expires_at === NOW + 21600, JSON.stringify(r));

console.log('refreshViaProxy error surfaces');
globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
let threw = false;
try { await refreshViaProxy('https://x/api', 'rt'); } catch (e) { threw = /proxy error 400/.test(e.message); }
ok('non-OK proxy response throws a clear error', threw);

console.log('mapStravaActivity still normalizes (sanity)');
const a = mapStravaActivity({ id: 42, type: 'Run', start_date: '2026-09-01T06:00:00Z', elapsed_time: 3600, distance: 10000, average_heartrate: 150 });
ok('maps sport + stable id', a.sport === 'run' && a.stravaId === 42 && a.id.startsWith('a'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
