// Netlify Function: hands-off Strava token refresh.
// The browser must never hold your Strava CLIENT SECRET, so this function does
// the token exchange server-side. It lives on the same Netlify site as the app,
// so the app can call it same-origin at /.netlify/functions/strava-oauth.
//
// Set these in Netlify → Site settings → Environment variables:
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
//
// Node 18+ (Netlify default) provides a global fetch — no dependencies needed.

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',            // lets the app call it from any origin (e.g. github.io)
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* leave empty */ }

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type: body.grant_type || 'authorization_code',
  });
  if (body.grant_type === 'refresh_token') params.set('refresh_token', body.refresh_token || '');
  else params.set('code', body.code || '');

  try {
    const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', body: params });
    const data = await r.json();
    // Return only what the client needs — never the client secret.
    return {
      statusCode: r.ok ? 200 : 400,
      headers,
      body: JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at, error: data.message }),
    };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(e) }) };
  }
};
