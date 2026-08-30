// Optional serverless helper for hands-off Strava token refresh.
// The browser must never hold your Strava CLIENT SECRET, so this tiny function
// does the token exchange server-side. Deploy it to Vercel, Netlify Functions,
// Cloudflare Workers, or any Node host, then put its URL in the app (or wire it
// into strava.js -> refreshViaProxy).
//
// Set these environment variables on the host:
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
//
// --- Vercel / Node (api/strava-oauth.js) ------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { grant_type, code, refresh_token } = req.body || {};
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type: grant_type || 'authorization_code',
  });
  if (grant_type === 'refresh_token') params.set('refresh_token', refresh_token);
  else params.set('code', code);

  const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body: params });
  const data = await r.json();
  // return only what the client needs (never the client secret)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(r.ok ? 200 : 400).json({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  });
}

/* --- Cloudflare Worker variant ---------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('', { status: 405 });
    const body = await request.json();
    const params = new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: body.grant_type || 'authorization_code',
    });
    if (body.grant_type === 'refresh_token') params.set('refresh_token', body.refresh_token);
    else params.set('code', body.code);
    const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body: params });
    const d = await r.json();
    return new Response(JSON.stringify({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at }),
      { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
};
----------------------------------------------------------------------------- */
