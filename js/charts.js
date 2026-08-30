// charts.js — dependency-free SVG charts (no CDN, works offline).
// Every function returns an SVG markup string; the caller sets innerHTML.
// Colors come from CSS variables so charts adapt to light/dark automatically.

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// Nice axis bounds.
function niceBounds(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(range / 4)));
  const err = (range / 4) / step;
  const mult = err >= 7.5 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
  const s = mult * step;
  return { lo: Math.floor(min / s) * s, hi: Math.ceil(max / s) * s, step: s };
}

// The Performance Management Chart: CTL (fitness, filled), ATL (fatigue, line)
// on the left axis; TSB (form) on a right axis around zero.
export function pmcChart(pmc) {
  if (!pmc.length) return emptyChart('No data yet — import a file or add a session.');
  const W = 760, H = 320, padL = 44, padR = 46, padT = 16, padB = 34;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = pmc.length;
  const x = i => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

  const loadMax = Math.max(1, ...pmc.map(p => Math.max(p.ctl, p.atl)));
  const lb = niceBounds(0, loadMax);
  const yL = v => padT + ih - ((v - lb.lo) / (lb.hi - lb.lo)) * ih;

  const tsbVals = pmc.map(p => p.tsb);
  const tb = niceBounds(Math.min(-1, ...tsbVals), Math.max(1, ...tsbVals));
  const yR = v => padT + ih - ((v - tb.lo) / (tb.hi - tb.lo)) * ih;

  const todayIdx = pmc.findIndex(p => p.isFuture);
  const splitX = todayIdx > 0 ? x(todayIdx) : null;

  // area for CTL
  let area = `M ${x(0)} ${yL(pmc[0].ctl)}`;
  pmc.forEach((p, i) => { area += ` L ${x(i)} ${yL(p.ctl)}`; });
  area += ` L ${x(n - 1)} ${yL(lb.lo)} L ${x(0)} ${yL(lb.lo)} Z`;

  const line = (accessor, y) => pmc.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(accessor(p))}`).join(' ');

  // gridlines + left labels
  let grid = '';
  for (let v = lb.lo; v <= lb.hi + 1e-9; v += lb.step) {
    grid += `<line x1="${padL}" y1="${yL(v)}" x2="${W - padR}" y2="${yL(v)}" class="grid"/>`;
    grid += `<text x="${padL - 6}" y="${yL(v) + 3}" class="axis" text-anchor="end">${Math.round(v)}</text>`;
  }
  // right labels (TSB)
  let rlabels = '';
  for (let v = tb.lo; v <= tb.hi + 1e-9; v += tb.step) {
    rlabels += `<text x="${W - padR + 6}" y="${yR(v) + 3}" class="axis form" text-anchor="start">${Math.round(v)}</text>`;
  }
  rlabels += `<line x1="${padL}" y1="${yR(0)}" x2="${W - padR}" y2="${yR(0)}" class="zero"/>`;

  // x labels (~6)
  let xlabels = '';
  const stepX = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += stepX) {
    const d = pmc[i].day.slice(5); // MM-DD
    xlabels += `<text x="${x(i)}" y="${H - 10}" class="axis" text-anchor="middle">${d}</text>`;
  }

  const futureShade = splitX != null
    ? `<rect x="${splitX}" y="${padT}" width="${W - padR - splitX}" height="${ih}" class="future"/>
       <line x1="${splitX}" y1="${padT}" x2="${splitX}" y2="${padT + ih}" class="today"/>
       <text x="${splitX + 4}" y="${padT + 11}" class="axis today-lbl">today</text>` : '';

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet" role="img">
    ${grid}${futureShade}
    <path d="${area}" class="ctl-area"/>
    <path d="${line(p => p.ctl, yL)}" class="ctl-line"/>
    <path d="${line(p => p.atl, yL)}" class="atl-line"/>
    <path d="${line(p => p.tsb, yR)}" class="tsb-line"/>
    ${rlabels}${xlabels}
  </svg>`;
}

// Stacked weekly volume (hours) by sport.
export function weeklyVolumeChart(weeks, sportColors) {
  if (!weeks.length) return emptyChart('No sessions logged yet.');
  const show = weeks.slice(-16);
  const W = 760, H = 260, padL = 34, padR = 12, padT = 12, padB = 40;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxH = Math.max(1, ...show.map(w => w.hours));
  const b = niceBounds(0, maxH);
  const y = v => padT + ih - (v / b.hi) * ih;
  const bw = iw / show.length * 0.66;
  const gap = iw / show.length;

  let grid = '';
  for (let v = 0; v <= b.hi + 1e-9; v += b.step) {
    grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" class="grid"/>`;
    grid += `<text x="${padL - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${v % 1 ? v.toFixed(1) : v}</text>`;
  }
  const sports = ['swim', 'bike', 'run', 'strength', 'other'];
  let bars = '';
  show.forEach((w, i) => {
    const cx = padL + i * gap + (gap - bw) / 2;
    let acc = 0;
    for (const sp of sports) {
      const secs = w.bySport[sp] || 0;
      if (!secs) continue;
      const h = secs / 3600;
      const yTop = y(acc + h), yBot = y(acc);
      bars += `<rect x="${cx}" y="${yTop}" width="${bw}" height="${Math.max(0, yBot - yTop)}" fill="${sportColors[sp] || sportColors.other}"><title>${sp}: ${h.toFixed(1)}h (week of ${w.weekStart})</title></rect>`;
      acc += h;
    }
    if (i % 2 === 0) bars += `<text x="${cx + bw / 2}" y="${H - 22}" class="axis" text-anchor="middle">${w.weekStart.slice(5)}</text>`;
    bars += `<text x="${cx + bw / 2}" y="${y(w.hours) - 4}" class="axis small" text-anchor="middle">${w.hours ? w.hours.toFixed(1) : ''}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>`;
}

// Horizontal breakdown of load by sport over a window.
export function loadBySportChart(bySport, sportColors) {
  const entries = Object.entries(bySport).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return emptyChart('No load in this window.');
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return `<div class="bars">${entries.map(([sp, v]) => {
    const pct = (v / total) * 100;
    return `<div class="bar-row"><span class="bar-lbl">${sp}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%;background:${sportColors[sp] || sportColors.other}"></span></span>
      <span class="bar-val">${Math.round(v)} <small>(${pct.toFixed(0)}%)</small></span></div>`;
  }).join('')}</div>`;
}

// Weight: raw points (faint) + smoothed trend line.
export function weightChart(series) {
  if (!series || series.length < 2) return emptyChart('Log a few days of weight to see the trend.');
  const W = 760, H = 220, padL = 40, padR = 12, padT = 12, padB = 28;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = series.length;
  const vals = series.flatMap(p => [p.kg, p.smooth]).filter(Number.isFinite);
  const b = niceBounds(Math.min(...vals), Math.max(...vals));
  const x = i => padL + (i / (n - 1)) * iw;
  const y = v => padT + ih - ((v - b.lo) / (b.hi - b.lo)) * ih;
  let grid = '';
  for (let v = b.lo; v <= b.hi + 1e-9; v += b.step) {
    grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" class="grid"/>`;
    grid += `<text x="${padL - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${v % 1 ? v.toFixed(1) : v}</text>`;
  }
  const raw = series.map((p, i) => Number.isFinite(p.kg) ? `${i && Number.isFinite(series[i-1].kg) ? 'L' : 'M'} ${x(i)} ${y(p.kg)}` : '').join(' ');
  const smooth = series.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(p.smooth)}`).join(' ');
  let xl = '';
  const step = Math.max(1, Math.floor(n / 6));
  for (let i = 0; i < n; i += step) xl += `<text x="${x(i)}" y="${H - 8}" class="axis" text-anchor="middle">${series[i].day.slice(5)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">${grid}
    <path d="${raw}" fill="none" stroke="var(--faint)" stroke-width="1" opacity=".6"/>
    <path d="${smooth}" fill="none" stroke="var(--accent-2)" stroke-width="2.4"/>${xl}</svg>`;
}

// Generic time-point trend (e.g. the aerobic performance index).
export function trendChart(points, opts = {}) {
  if (!points || points.length < 3) return emptyChart(opts.empty || 'Not enough data yet.');
  const W = 760, H = 220, padL = 36, padR = 12, padT = 12, padB = 28;
  const iw = W - padL - padR, ih = H - padT - padB;
  const days = points.map(p => p.day);
  const minD = days[0], maxD = days[days.length - 1];
  const span = Math.max(1, (new Date(maxD) - new Date(minD)) / 86400000);
  const xs = d => padL + ((new Date(d) - new Date(minD)) / 86400000 / span) * iw;
  const vals = points.map(p => p.p);
  const b = niceBounds(Math.min(...vals), Math.max(...vals));
  const y = v => padT + ih - ((v - b.lo) / (b.hi - b.lo)) * ih;
  let grid = '';
  for (let v = b.lo; v <= b.hi + 1e-9; v += b.step) grid += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" class="grid"/>`;
  grid += `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" class="zero"/>`;
  const dots = points.map(p => `<circle cx="${xs(p.day)}" cy="${y(p.p)}" r="2.4" fill="var(--accent)"><title>${p.day}: ${p.p.toFixed(2)}</title></circle>`).join('');
  // simple moving trend line
  const sorted = [...points].sort((a, b2) => a.day.localeCompare(b2.day));
  const line = sorted.map((p, i) => `${i ? 'L' : 'M'} ${xs(p.day)} ${y(p.p)}`).join(' ');
  let xl = '';
  const step = Math.max(1, Math.floor(points.length / 6));
  for (let i = 0; i < points.length; i += step) xl += `<text x="${xs(points[i].day)}" y="${H - 8}" class="axis" text-anchor="middle">${points[i].day.slice(5)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">${grid}
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.4" opacity=".55"/>${dots}${xl}</svg>`;
}

function emptyChart(msg) {
  return `<div class="chart-empty">${esc(msg)}</div>`;
}
