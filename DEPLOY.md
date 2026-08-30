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

## Letting Claude push updates for you
In a future session, Claude produces the changes. Then either:
- You've run `gh auth login` in that session → Claude commits and pushes; auto-deploy
  takes it live. Or
- Claude hands you the changed files / a patch and you push. Same result.
