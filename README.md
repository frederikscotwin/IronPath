# IronPath

A personal triathlon training app — plan, log, and analyze your road to an Ironman. It runs entirely on your device as an installable PWA, holds your own data, and the analytics are transparent: every number comes from a formula you can read and retune in Settings. It also does the thing the big apps won't — it exports a clean, structured snapshot of your training that you can hand to an AI for coaching advice.

Built as vanilla JavaScript with **no build step and no runtime dependencies** — nothing loads from a CDN, so it works fully offline and is yours to extend.

## Run it locally

The app uses ES modules, a service worker, and IndexedDB, so it must be served over HTTP (opening `index.html` from the file system won't work). Any static server does:

```bash
cd ironpath
python3 -m http.server 8000
# then open http://localhost:8000
```

or with Node:

```bash
npx serve .
```

## Put it on your iPhone

Host the folder somewhere with HTTPS (see below), open the URL in Safari, then **Share → Add to Home Screen**. It installs as a standalone app called IronPath, works offline, and keeps its data between launches. (Add to Home Screen requires HTTPS, which is why a hosted deploy — not just localhost — is needed for the phone.)

Free hosting that works well:

- **Netlify** — drag the `ironpath` folder onto app.netlify.com/drop.
- **GitHub Pages** — push the folder to a repo and enable Pages.
- **Vercel** — `vercel` in the folder (it's a static site).

## Getting your training data in

Three ways, all landing in the same normalized store:

1. **File import** (the reliable, self-owned path). On the **Log** tab, *Import*, and pick one or many files:
   - `.fit` — Garmin's native export. Full summary decoded (sport, time, distance, HR, speed, calories). Multisport `.fit` files produce one session per leg.
   - `.tcx` — Garmin "Export to TCX" per activity. Full summary. Note: Garmin pool swims export with no sport tag (they show as *Other*), so set the sport after importing a swim TCX. `.fit` and Strava tag swims correctly.
   - `.gpx` — has no sport tag either; set it after import.
   To pull your whole history at once, use Garmin's bulk export or Strava's "Download your data", then import the files.

2. **Strava sync**. In **Setup → Strava**, paste a personal Access Token, then *Sync Strava* on the Log tab. Since Garmin auto-pushes to Strava, this also captures your Garmin activities. Strava tokens expire after ~6 hours; for hands-off refresh, deploy `server/strava-oauth.js` (it keeps your client secret off the browser) and wire its URL into `js/strava.js` → `refreshViaProxy`.

3. **Manual entry**. *Add session* on Home or Log — sport, duration, distance, HR, RPE, notes.

Everything stays on your device. **Setup → Export backup** gives you a full JSON copy (settings, plan, every session) you can re-import anywhere.

## How the analytics work (and how to tune them)

The unified training-load currency is **heart-rate TRIMP** (Banister), because HR is the one signal you have across swim, bike, and run:

```
TRIMP = minutes × HRr × 0.64 × e^(b·HRr)
HRr   = (avgHR − restHR) / (maxHR − restHR)      b = 1.92 (male) / 1.67 (female)
```

When a session has no HR, load falls back to RPE (an editable mapping), then to a per-sport default — each flagged by confidence. On top of daily load sits the classic **Performance Management Chart**:

- **Fitness (CTL)** — a slow exponential average of daily load (default 42-day).
- **Fatigue (ATL)** — a fast exponential average (default 7-day).
- **Form (TSB)** — yesterday's Fitness minus yesterday's Fatigue.

Alongside, informational **sport-specific scores** use a better signal where you have one: swim **sSS** from Critical Swim Speed and run **rTSS** from threshold pace (both scaled so 100 points = one hour at threshold). These enrich the picture but don't drive the PMC, so the fitness model stays genuinely unified.

Every constant — `maxHr`, `restHr`, the CTL/ATL time constants, the TRIMP weight `b`, the suggestion thresholds, CSS and run threshold pace — lives in **Setup** and in `DEFAULT_SETTINGS` (`js/store.js`). Calibrate the HR anchors from real efforts, set CSS from a 400 m swim time trial, and set run threshold from a 30-minute run time trial, and the numbers become yours.

## The AI coach export

The **AI** tab builds one self-describing JSON payload — your thresholds, every normalized session, the rolling CTL/ATL/TSB series, weekly volume, and your plan — plus a ready-made coaching prompt. Copy both into Claude (or any LLM) and ask for recommendations grounded in your actual numbers, or download the JSON to keep.

## The plan

The **Plan** tab seeds an editable base-building block sized to your weekly hours, then lets you reshape every session inline (sport, duration, title, add/delete). The projected-fitness chart shows the CTL/ATL/TSB curve your *actual + planned* load implies, so you can see a hard week coming before you live it. Nothing is prescribed; the plan bends to you.

## Project layout

```
index.html            app shell + tab bar
manifest.webmanifest  PWA manifest
sw.js                 service worker (offline shell cache — bump CACHE when you edit shell files)
css/styles.css        styles (dark-first, light via prefers-color-scheme)
js/
  app.js              UI controller, routing, all interactions
  store.js            IndexedDB + settings/plan + JSON backup
  model.js            the analytics engine (TRIMP, PMC, suggestions) — pure, unit-tested
  parsers.js          FIT / TCX / GPX import
  charts.js           dependency-free SVG charts
  strava.js           Strava fetch + token helpers
  plan.js             plan data + base-block generator
  aiexport.js         AI payload + prompt builder
server/
  strava-oauth.js     optional serverless token-exchange helper
tests/                Node unit tests, browser smoke test, sample-file generators
icons/                app icons
```

## Tests

```bash
node tests/model.test.mjs      # analytics engine (29 assertions)
node tests/browser.mjs         # headless import of 86 sample files + screenshots
```

`tests/generate_samples.py` regenerates the sample `.tcx`/`.gpx`/`.fit` files (the `.fit` is produced by an independent encoder to validate the binary decoder).

## A note on what's solid vs. what to watch

- The analytics engine and the TCX/GPX import are unit- and browser-tested.
- The FIT decoder is validated against an independent encoder for the summary fields the app uses; when you import your first real Garmin `.fit`, glance at the numbers to be sure a device quirk isn't throwing something off. If anything looks wrong, the TCX export of the same activity is the reliable fallback.
- Thresholds ship with sensible placeholders — the model is only as honest as your `maxHr`/`restHr`/CSS/threshold-pace, so calibrate those early.
