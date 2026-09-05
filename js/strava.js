// strava.js — pull activities straight from Strava's API in the browser.
// -----------------------------------------------------------------------------
// Simplest path (works today): paste a personal Access Token in Settings. Strava
// tokens expire ~6h, so for hands-off refresh you deploy the tiny serverless
// function documented in README (server/strava-oauth). Both paths end here, with
// a bearer token we use to fetch and normalize your activities.
// -----------------------------------------------------------------------------

import { streamMetrics } from './parsers.js';

const STRAVA_SPORT = {
  Run: 'run', TrailRun: 'run', VirtualRun: 'run', Treadmill: 'run',
  Ride: 'bike', VirtualRide: 'bike', GravelRide: 'bike', MountainBikeRide: 'bike', EBikeRide: 'bike',
  Swim: 'swim',
  WeightTraining: 'strength', Workout: 'strength', Crossfit: 'strength',
};

export function mapStravaActivity(a) {
  const type = a.sport_type || a.type || 'Workout';
  const sport = STRAVA_SPORT[type] || 'other';
  const start = a.start_date || a.start_date_local;
  const durationSec = a.elapsed_time || a.moving_time || 0;
  const obj = {
    source: 'strava',
    stravaId: a.id,
    sport,
    startTime: start ? new Date(start).toISOString() : new Date().toISOString(),
    durationSec,
    distanceM: a.distance || null,
    avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
    maxHr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
    avgSpeed: a.average_speed || null,
    elevationGainM: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
    calories: a.calories || null,
    name: a.name || '',
  };
  // stable id incorporating the strava id
  let h = 0x811c9dc5; const s = 'strava' + a.id;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  obj.id = 'a' + h.toString(16).padStart(8, '0');
  return obj;
}

// Fetch pages of activities after a given epoch (seconds). Returns normalized list.
export async function fetchStravaActivities(token, afterEpoch = 0, maxPages = 10) {
  if (!token) throw new Error('No Strava access token set (Settings → Strava).');
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://www.strava.com/api/v3/athlete/activities?per_page=100&page=${page}` +
      (afterEpoch ? `&after=${afterEpoch}` : '');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new Error('Strava token rejected (expired or wrong scope). Refresh it in Settings.');
    if (!res.ok) throw new Error(`Strava API error ${res.status}.`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    for (const a of batch) out.push(mapStravaActivity(a));
    if (batch.length < 100) break;
  }
  return out;
}

// Fetch the full time-series for one activity and derive best-efforts,
// decoupling and grade-adjusted efforts — the same metrics file import produces.
export async function fetchStravaStreams(token, id, sport) {
  const url = `https://www.strava.com/api/v3/activities/${id}/streams?keys=time,distance,heartrate,altitude&key_by_type=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new Error('Strava rate limit hit — try again in a few minutes.');
  if (!res.ok) return null;
  const s = await res.json();
  const time = s.time?.data;
  if (!time || !time.length) return null;
  const dist = s.distance?.data, hr = s.heartrate?.data, alt = s.altitude?.data;
  const stream = time.map((t, i) => ({ t, d: dist ? dist[i] : null, hr: hr ? hr[i] : null, ele: alt ? alt[i] : null }));
  return streamMetrics(stream, sport);
}

// Detailed activity: perceived exertion, description, private note, relative
// effort, calories, gear — fields the summary list endpoint doesn't include.
export async function fetchStravaDetail(token, id) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${id}?include_all_efforts=false`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new Error('Strava rate limit hit — try again in a few minutes.');
  if (!res.ok) return null;
  const a = await res.json();
  return {
    perceivedExertion: a.perceived_exertion ?? null, // 1-10 if you logged it
    description: a.description || '',
    privateNote: a.private_note || '',
    relativeEffort: a.suffer_score ?? null,
    calories: a.calories ?? null,
    gear: a.gear ? (a.gear.name || null) : null,
  };
}

// Should we refresh the access token now? Only when a proxy + refresh token are
// configured AND the current access token is missing or within `graceSec` of
// expiry. Without a proxy we leave the manually-pasted token alone. Pure — unit-tested.
export function stravaNeedsRefresh(settings, nowSec = Math.floor(Date.now() / 1000), graceSec = 120) {
  if (!settings || !settings.stravaProxyUrl || !settings.stravaRefreshToken) return false;
  return !(settings.stravaTokenExpiry && settings.stravaTokenExpiry - nowSec > graceSec);
}

// Optional: exchange an authorization code / refresh token via your serverless
// proxy (so client secret never touches the browser). proxyUrl is your function.
export async function refreshViaProxy(proxyUrl, refreshToken) {
  const res = await fetch(proxyUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`OAuth proxy error ${res.status}.`);
  return res.json(); // { access_token, expires_at, refresh_token }
}
