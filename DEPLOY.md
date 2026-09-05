# Deploying, sharing, and updating IronPath

The app is a static PWA with **no server**. Each person's data lives only in their
own browser on their own phone. So sharing = sharing a URL; every installed copy
updates itself whenever the files at that URL change.

## Put it on one stable URL (do this once)

Pick one. All give HTTPS (required for "Add to Home Screen").

### Option A — GitHub Pages (no extra service; auto-deploys on push)
1. Create a new GitHub repo and push this folder to it (default branch `main`).
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included `.github/workflows/deploy-pages.yml` deploys on every push (and via
   the manual **Run workflow** button). Your URL is `https://<user>.github.io/<repo>/`.

### Option B — Netlify or Cloudflare Pages (nicer root-domain URL)
1. Push this folder to a GitHub repo (as above).
2. In Netlify/Cloudflare, **Add site → Import from Git**, pick the repo. No build
   command; publish directory `.`. `netlify.toml` is already set up.
3. You get a URL like `https://ironpath.netlify.app` — better for a PWA (no subpath).

## Share with friends
Send them the URL. Each opens it **in Safari** (iPhone) → Share → **Add to Home
Screen**. Each gets a private, independent copy — no data is shared between people.

- Each friend needs their **own** Strava token, or can just import files (easier).
- **Never share your backup JSON with a friend** — it contains your Strava token and
  all your data. Everyone starts fresh and keeps their own backups.

## Push an update to everyone
Because everyone installed from the same URL, an update = a change to that site:

- **Auto-deploy (recommended):** commit + push to `main`. GitHub Actions (or the
  Netlify/Cloudflare Git integration) redeploys automatically. Every installed copy
  picks up the new version on next launch — the service worker's `CACHE` name is
  bumped each release so it refreshes.
- **Manual (Netlify Drop):** drag the folder onto the same Netlify site again.

Keep the **same URL** forever. Data is tied to the origin, so a stable URL means
everyone keeps their history across updates; a new URL would look like a brand-new
app with empty memory (migrate via Export/Import backup if that ever happens).

## Hands-off Strava sync (never re-paste a token)

Strava **access tokens expire after ~6 hours** — even more often than daily — so a
token pasted into Setup stops working the same day. The fix is a tiny function that
holds your Strava *client secret* and trades a long-lived *refresh token* for a fresh
access token on demand. The app on GitHub Pages can't run this itself (Pages serves
static files only), so it lives on a free host that runs code. Two moving parts:
your app stays where it is; the function is a separate micro-service the app calls.

The function ships two ways in this repo: `netlify/functions/strava-oauth.js` (a
Netlify Function, wired up in `netlify.toml`) and `server/strava-oauth.js` (the same
logic as a Vercel handler / Cloudflare Worker). Pick the host you already use.

### Netlify (recommended if you have an account — app + function on one site)

1. **Get your Strava app credentials.** strava.com/settings/api → note the **Client
   ID** and **Client Secret**. Set *Authorization Callback Domain* to `localhost` (only
   used for the one-time authorize in step 3).
2. **Deploy this repo to Netlify.** *Add new site → Import an existing project*, pick
   the IronPath repo (no build command; publish dir `.` — `netlify.toml` sets both,
   plus the functions directory). In **Site settings → Environment variables** add
   `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`, then trigger a deploy. The site
   serves the app *and* the function; the function is at
   `https://<site>.netlify.app/.netlify/functions/strava-oauth`.
3. **Get your one-time refresh token.** In a browser, visit (one line, your Client ID):
   `https://www.strava.com/oauth/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http://localhost/exchange_token&approval_prompt=force&scope=activity:read_all`
   Approve. You land on a `http://localhost/exchange_token?...&code=XXXX&...` URL that
   won't load — that's fine; copy the **`code`** value out of the address bar. Trade it
   once for tokens:
   `curl -X POST https://<site>.netlify.app/.netlify/functions/strava-oauth -H "Content-Type: application/json" -d '{"grant_type":"authorization_code","code":"XXXX"}'`
   The response contains a **`refresh_token`** — the long-lived one you keep.
4. **Put them in the app.** Setup → Strava → *Auto-refresh*: paste the function URL and
   the refresh token, Save. From now on the app fetches a fresh access token itself
   before each sync — you never touch a token again; the status line shows how long the
   current token is valid.
   - If you now open the app at the **Netlify URL** (rather than github.io), the app and
     function are same-origin, so you can shorten the proxy field to just
     `/.netlify/functions/strava-oauth`. Note that switching URL means a fresh empty
     app (data is tied to the origin) — Export a backup on the old URL and Import it on
     the new one if you've logged anything.
   - If you keep the app on **github.io**, use the full `https://<site>.netlify.app/...`
     URL in the proxy field; the function's CORS header allows the cross-origin call.

### Vercel / Cloudflare (alternative)

Use `server/strava-oauth.js` instead: on Vercel drop it at `api/strava-oauth.js` (URL
`…/api/strava-oauth`); on Cloudflare use the Worker variant commented at the bottom of
the file. Set the same two env vars, then follow steps 3–4 with that URL.

Keep the Client Secret only on the host (its env vars) — never in the app, a URL, or a
chat. The refresh token is stored on your device like the rest of your data.

## Letting Claude push updates for you
In a future session, Claude produces the changes. Then either:
- You've run `gh auth login` in that session → Claude commits and pushes; auto-deploy
  takes it live. Or
- Claude hands you the changed files / a patch and you push. Same result.
