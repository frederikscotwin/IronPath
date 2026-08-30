# IronPath

A personal triathlon training app — plan, log, and analyze your road to an Ironman. It runs entirely on your device as an installable PWA, holds your own data, and the analytics are transparent: every number comes from a formula you can read and retune in Settings. It tracks your weight and turns it into energy expenditure (blendable with TRIMP as the load basis), estimates your thresholds and zones from your best sustained efforts, calibrates its fatigue/form model to your data, predicts race times and readiness, adapts your plan to your fatigue, plans your taper and race-day pacing/fuelling, and exports structured workouts to your Garmin. And it does the thing the big apps won't — it exports a clean, structured snapshot of your training that you can hand to an AI for coaching advice.

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

Every constant — `maxHr`, `restHr`, the CTL/ATL time constants, the TRIMP weight `b`, the suggestion thresholds, CSS and run threshold pace — lives in **Setup** and in `DEFAULT_SETTINGS` (`js/store.js`). Calibrate the HR anchors from real efforts, set CSS from a 400 m swim time trial, and set run threshold from a 30-minute run time trial, and the numbers become yours — or let the app estimate them for you (below).

## Weight and energy

Log your weight day to day on the **Log** tab. Weight does two jobs. First, it turns each session into an energy figure: with HR we use the Keytel et al. (2005) regression (which needs mass, age and sex), and without HR a MET estimate scaled by mass — so heavier days and higher-HR days cost more calories, as they should. Set your age in **Setup → Energy & weight** to sharpen it. Second, you choose the whole fitness model's **load basis** there — **TRIMP** (heart-rate strain, the default), **Energy** (kcal), or **Combined**, a blend of the two. Combined is usually the best of both: TRIMP captures cardiovascular strain and energy captures metabolic cost, and they measure genuinely different things. The blend slider sets how much weight goes on energy. To keep your Fitness/Fatigue numbers on a familiar scale whatever you pick, energy is rescaled so its total matches TRIMP's before blending — so switching basis re-weights the *shape* of your curves without lurching the numbers. Weight also feeds the run-economy term in the finish projection, and a rapid drop (dehydration or under-fuelling) pulls down your readiness score. A missed day carries the last value forward.

## Auto-estimated thresholds, zones and self-calibration (the Coach tab)

The **Coach** tab reads your history and estimates your max HR, resting HR, threshold HR, Critical Swim Speed and run-threshold pace, each with a confidence, plus HR/pace/swim training zones. Each estimate has an **Accept** button that copies it into your settings — nothing is applied silently.

Estimates draw on three sources, in priority order: any **benchmark tests** you log (Log → Add test: a 400 m swim TT with a 200 m split gives CSS exactly; a 20-min run or bike TT gives threshold); your **best sustained 20-minute efforts**, parsed from the actual file streams; and, as a fallback, your **session averages**. The stream parsing reads the trackpoint/record time series inside every `.tcx`, `.gpx` and `.fit` (including Garmin's compressed-timestamp records) and builds a mean-max curve — your best sustained speed and HR over 5, 10, 20, 30 and 60-minute windows — shown in the **Best efforts (mean-max)** card. Only a compact per-session summary of these bests is stored, not the raw streams, so it stays light. A best-20-minute effort is a far better threshold proxy than a whole-session average, so this is what sharpens the estimates once you've imported real files.

The **self-calibrating fatigue/form model** fits the impulse-response model to *your* data. It builds a performance proxy from your efficiency factor (speed per heartbeat on steady sessions, which rises as aerobic fitness improves), then grid-searches the fitness and fatigue time constants and least-squares-fits the fitness/fatigue gains, reporting the best-fit `τ`'s, gains and an R². When the fit is good you can accept the fitted constants; when the signal is still weak it says so and keeps the standard 42/7. This is the classic Banister calibration, done transparently — the unit test recovers planted time constants from synthetic data to prove the fit works.

## Performance prediction

Also on **Coach**:

- **What you could do today** — predicted 5 k and 10 k times (Riegel from your threshold), run-threshold pace, swim CSS pace and threshold HR, nudged slightly by today's form.
- **Ironman finish projection** — swim/bike/run splits and total, from your estimated thresholds with editable long-course intensity factors, your weight (run economy) and a fitness-based durability term. The bike split is the least certain without power and leans on your recent long-ride speed; every assumption is editable in Setup.
- **Race readiness** — set a race date and get a 0–100 score for that day, combining projected form (weighted highest — being fresh on the day matters most), fitness and weight-trend stability.

## The AI coach export

The **AI** tab builds one self-describing JSON payload — your thresholds, every normalized session, the rolling CTL/ATL/TSB series, weekly volume, and your plan — plus a ready-made coaching prompt. Copy both into Claude (or any LLM) and ask for recommendations grounded in your actual numbers, or download the JSON to keep.

## The plan

The **Plan** tab seeds an editable base-building block sized to your weekly hours, then lets you reshape every session inline (sport, duration, title, add/delete). The projected-fitness chart shows the CTL/ATL/TSB curve your *actual + planned* load implies, so you can see a hard week coming before you live it. Nothing is prescribed; the plan bends to you.

## Auto-regulation — the plan adapts to your fatigue

The app watches three fatigue signals derived from your daily load: **form (TSB)**, the **acute:chronic workload ratio** (ACWR — your 7-day load vs 28-day, where outside ~0.8–1.3 is the danger zone), and **Foster monotony/strain** (how samey your training is). These drive a daily **readiness light** (green/amber/red) on the dashboard, and an **adaptation pass** on the Plan tab: when you're overreaching (form below your deep-fatigue line, or ACWR spiking) it proposes easing the two hardest upcoming sessions — shown as a diff (`Long ride 122 → 73 load`) you **Apply** or dismiss. High monotony is treated as an "add variety" nudge, not a reason to cut volume. Turn on **Auto-apply** and it reshapes the upcoming week for you each time you open the Plan tab; leave it off for suggest-and-approve. Everything is transparent and every threshold lives in Setup.

## Taper and race-day plan

With a race date set, **Generate taper** on the Plan tab back-solves the final few weeks — progressively cutting volume while keeping a little intensity, resting the day before — and the projected-fitness chart shows the form rise it produces. The **Race-day plan** on the Coach tab gives per-leg pacing (target pace and HR band per discipline, from your thresholds) and a fuelling sheet: carbs, fluid and sodium per hour of bike+run, totals, and an estimated calorie burn — all rates editable in Setup.

## Durability, grade-adjusted pace, and Strava streams

From the session streams the app computes **aerobic decoupling** — how much your pace-per-heartbeat fades from the first half to the second half of a long session (under ~5% is strong Ironman durability) — and tracks it over time on the Coach tab. Runs also get **grade-adjusted pace** (Minetti's cost-of-running model), so a hilly run's best-20-minute effort is judged on equivalent-flat terms and doesn't understate your threshold. And **Fetch Strava streams** (Log tab) pulls the full time-series for synced activities via Strava's streams endpoint, so they get the same best-efforts, decoupling and grade-adjustment as imported files (rate-limited to a handful per click).

## Structured workouts to your Garmin

Every planned session has a **⌚ export**: it generates a structured workout (warm-up, main set — intervals for hard sessions, steady otherwise, with HR targets from your threshold — and cool-down) and exports it as a **Garmin FIT workout file** you import in Garmin Connect → Workouts, plus JSON and plain-text fallbacks. The encoder is round-trip-validated by the app's own decoder; check your first real import. A **test scheduler** (Setup) reminds you to run a benchmark TT every few weeks so your thresholds stay fresh.

## Project layout

```
index.html            app shell + tab bar
manifest.webmanifest  PWA manifest
sw.js                 service worker (offline shell cache — bump CACHE when you edit shell files)
css/styles.css        styles (dark-first, light via prefers-color-scheme)
js/
  app.js              UI controller, routing, all interactions
  store.js            IndexedDB + settings/plan + JSON backup
  model.js            core analytics (TRIMP, energy, weight, PMC, suggestions) — pure, unit-tested
  estimate.js         threshold/zone estimation, self-calibration fit, prediction, durability
  adapt.js            fatigue signals (ACWR/monotony), readiness, plan adaptation
  race.js             race-day pacing + fuelling
  fitworkout.js       structured workout + Garmin FIT workout encoder/decoder
  parsers.js          FIT / TCX / GPX import + stream metrics (best efforts, decoupling, GAP)
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
node tests/model.test.mjs      # core engine: TRIMP, energy, weight, PMC (29 assertions)
node tests/estimate.test.mjs   # estimation, impulse-response fit recovery, prediction (31)
node tests/streams.test.mjs    # mean-max, FIT record decode, combined basis, best-effort estimation (20)
node tests/coach2.test.mjs     # fatigue signals, adaptation, taper, race plan, decoupling/GAP, FIT workout (28)
node tests/browser.mjs         # headless import + weight/tests + plan/taper/workout + screenshots
```

`tests/generate_samples.py` regenerates the sample `.tcx`/`.gpx`/`.fit` files (the `.fit` is produced by an independent encoder to validate the binary decoder).

## A note on what's solid vs. what to watch

- The analytics engine and the TCX/GPX import are unit- and browser-tested.
- The FIT decoder (summary fields *and* record-level streams, including compressed timestamps) is validated against an independent encoder; when you import your first real Garmin `.fit`, glance at the numbers and the Best-efforts card to be sure a device quirk isn't throwing something off. If anything looks wrong, the TCX export of the same activity is the reliable fallback.
- Thresholds ship with sensible placeholders — the model is only as honest as your `maxHr`/`restHr`/CSS/threshold-pace, so calibrate those early.
