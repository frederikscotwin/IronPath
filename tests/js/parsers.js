// parsers.js — turn exported activity files into IronPath's normalized schema.
// -----------------------------------------------------------------------------
// Every parser returns an array of activity objects (one file can hold several,
// e.g. a multisport triathlon .fit). The normalized shape is:
//   { source, sport, startTime(ISO), durationSec, distanceM, avgHr, maxHr,
//     avgSpeed(m/s), elevationGainM, calories, fileName }
// TCX and GPX are XML and fully supported. FIT is binary; we decode the summary
// (session) messages per the Garmin FIT spec — reliable for the fields above,
// but validate against your first real file since device quirks exist.
// -----------------------------------------------------------------------------

// Stable id from the fields that identify a session, so re-importing the same
// file doesn't create duplicates.
export function activityId(a) {
  const s = `${a.source}|${a.sport}|${a.startTime}|${Math.round(a.durationSec || 0)}|${Math.round(a.distanceM || 0)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return 'a' + h.toString(16).padStart(8, '0');
}

function finalize(a, fileName) {
  a.fileName = fileName;
  if (!a.avgSpeed && a.distanceM && a.durationSec) a.avgSpeed = a.distanceM / a.durationSec;
  a.id = activityId(a);
  return a;
}

// Mean-max effort durations (seconds): 5, 10, 20, 30, 60 min.
const DURS = [300, 600, 1200, 1800, 3600];

// Best sustained average of a cumulative quantity over the tightest window >= W.
function windowsBest(times, cum, W) {
  const n = times.length;
  if (n < 2 || times[n - 1] - times[0] < W) return null;
  let i = 0, best = null;
  for (let j = 1; j < n; j++) {
    while (i + 1 <= j && times[j] - times[i + 1] >= W) i++;
    const dt = times[j] - times[i];
    if (dt >= W) { const avg = (cum[j] - cum[i]) / dt; if (avg >= 0 && (best == null || avg > best)) best = avg; }
  }
  return best;
}

// From a stream of {t(sec), d(cumulative m|null), hr(bpm|null)} build the
// best-effort curve: for each duration, the best sustained avg speed and HR.
function meanMax(points, durs = DURS) {
  const pts = (points || []).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (pts.length < 3) return undefined;
  const t0 = pts[0].t;
  const times = pts.map(p => p.t - t0);
  const total = times[times.length - 1];
  const hasDist = pts.every(p => Number.isFinite(p.d));
  const dist = hasDist ? pts.map(p => p.d) : null;
  const hasHr = pts.some(p => Number.isFinite(p.hr));
  let hrArea = null;
  if (hasHr) {
    hrArea = [0];
    for (let k = 1; k < pts.length; k++) {
      const dt = times[k] - times[k - 1];
      const h0 = pts[k - 1].hr, h1 = pts[k].hr;
      const seg = (Number.isFinite(h0) && Number.isFinite(h1)) ? (h0 + h1) / 2 * dt
        : Number.isFinite(h1) ? h1 * dt : Number.isFinite(h0) ? h0 * dt : 0;
      hrArea.push(hrArea[k - 1] + seg);
    }
  }
  const out = {};
  for (const W of durs) {
    if (total < W) continue;
    const rec = {};
    const sp = dist ? windowsBest(times, dist, W) : null;
    const hr = hrArea ? windowsBest(times, hrArea, W) : null;
    if (Number.isFinite(sp) && sp > 0) rec.speed = +sp.toFixed(3);
    if (Number.isFinite(hr) && hr > 0) rec.hr = Math.round(hr);
    if (Object.keys(rec).length) out[String(Math.round(W / 60))] = rec;
  }
  return Object.keys(out).length ? { dur: out } : undefined;
}

// Minetti running energy cost vs gradient, normalized to flat — turns a segment
// of distance on a slope into "equivalent flat" distance (grade-adjusted pace).
function minettiFactor(i) {
  i = Math.max(-0.35, Math.min(0.35, i));
  const C = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
  return C / 3.6;
}
function gapCum(points) {
  const out = new Array(points.length).fill(0);
  let cum = 0;
  for (let k = 1; k < points.length; k++) {
    const dd = points[k].d - points[k - 1].d;
    const de = (points[k].ele ?? points[k - 1].ele ?? 0) - (points[k - 1].ele ?? points[k].ele ?? 0);
    if (dd > 0) cum += dd * minettiFactor(de / dd);
    out[k] = cum;
  }
  return out;
}
// Aerobic decoupling (%): how much efficiency (speed per beat) fades from the
// first half to the second half of a long session. Low = good durability.
function decoupling(points) {
  const pts = points.filter(p => Number.isFinite(p.t));
  if (pts.length < 10) return null;
  const t0 = pts[0].t, total = pts[pts.length - 1].t - t0;
  if (total < 45 * 60) return null;
  const mid = t0 + total / 2;
  const efOf = (a, b) => {
    let d0 = null, d1 = null, area = 0, dur = 0, tPrev = null, hrPrev = null;
    for (const p of pts) {
      if (p.t < a || p.t > b) continue;
      if (Number.isFinite(p.d)) { if (d0 == null) d0 = p.d; d1 = p.d; }
      if (Number.isFinite(p.hr)) { if (tPrev != null) { area += (hrPrev + p.hr) / 2 * (p.t - tPrev); dur += p.t - tPrev; } tPrev = p.t; hrPrev = p.hr; }
    }
    const dist = (d1 != null && d0 != null) ? d1 - d0 : null;
    const speed = dist != null ? dist / (b - a) : null;
    const hr = dur > 0 ? area / dur : null;
    return (speed && hr) ? speed / hr : null;
  };
  const ef1 = efOf(t0, mid), ef2 = efOf(mid, t0 + total);
  if (!ef1 || !ef2) return null;
  return +(((ef1 - ef2) / ef1) * 100).toFixed(1);
}
// One call for all stream-derived metrics, shared by file parsers and Strava.
export function streamMetrics(stream, sport) {
  const best = meanMax(stream);
  const decoup = decoupling(stream);
  let gapBest;
  const hasEle = stream.some(p => Number.isFinite(p.ele));
  const hasDist = stream.length > 2 && stream.every(p => Number.isFinite(p.d));
  if (sport === 'run' && hasEle && hasDist) {
    const g = gapCum(stream);
    gapBest = meanMax(stream.map((p, i) => ({ t: p.t, d: g[i], hr: p.hr })));
  }
  return { best, decoupling: decoup, gapBest };
}

const R = 6371000; // earth radius m
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- dispatch ---------------------------------------------------------------

export async function parseFile(file) {
  const name = (file.name || 'import').toLowerCase();
  if (name.endsWith('.fit')) {
    const buf = await file.arrayBuffer();
    return parseFit(buf, file.name);
  }
  const text = await file.text();
  if (name.endsWith('.tcx')) return parseTcx(text, file.name);
  if (name.endsWith('.gpx')) return parseGpx(text, file.name);
  // Try to sniff by content.
  if (text.includes('<TrainingCenterDatabase')) return parseTcx(text, file.name);
  if (text.includes('<gpx')) return parseGpx(text, file.name);
  throw new Error(`Unrecognized file type: ${file.name}`);
}

// ---- TCX --------------------------------------------------------------------

const TCX_SPORT = { Running: 'run', Biking: 'bike', Other: 'other', Swimming: 'swim' };

export function parseTcx(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const acts = [...doc.getElementsByTagName('Activity')];
  const out = [];
  for (const act of acts) {
    const sportAttr = act.getAttribute('Sport') || 'Other';
    let sport = TCX_SPORT[sportAttr] || 'other';
    const laps = [...act.getElementsByTagName('Lap')];
    if (!laps.length) continue;
    let totalTime = 0, totalDist = 0, calories = 0, hrSum = 0, hrTimeWt = 0, maxHr = 0, ele = 0;
    let prevEle = null;
    const stream = [];
    const startTime = laps[0].getAttribute('StartTime') || text.match(/<Id>([^<]+)<\/Id>/)?.[1];
    for (const lap of laps) {
      const t = num(lap, 'TotalTimeSeconds');
      const d = num(lap, 'DistanceMeters');
      const cal = num(lap, 'Calories');
      const avgHr = num(childOf(lap, 'AverageHeartRateBpm'), 'Value');
      const mHr = num(childOf(lap, 'MaximumHeartRateBpm'), 'Value');
      if (t) totalTime += t;
      if (d) totalDist += d;
      if (cal) calories += cal;
      if (avgHr && t) { hrSum += avgHr * t; hrTimeWt += t; }
      if (mHr) maxHr = Math.max(maxHr, mHr);
      // trackpoints: elevation gain + stream for best-effort analysis
      for (const tp of lap.getElementsByTagName('Trackpoint')) {
        const e = num(tp, 'AltitudeMeters');
        if (e != null) { if (prevEle != null && e > prevEle) ele += e - prevEle; prevEle = e; }
        const tEl = tp.getElementsByTagName('Time')[0];
        const t = tEl ? Date.parse(tEl.textContent) / 1000 : null;
        const dm = txtNum(tp, 'DistanceMeters');
        const hrEl = childOf(tp, 'HeartRateBpm');
        const hv = hrEl ? parseFloat(hrEl.getElementsByTagName('Value')[0]?.textContent) : NaN;
        if (Number.isFinite(t)) stream.push({ t, d: Number.isFinite(dm) ? dm : null, hr: Number.isFinite(hv) ? hv : null, ele: Number.isFinite(e) ? e : null });
      }
    }
    // Pool swims sometimes come through as "Other"; if distance-per-time looks like swimming, hint it.
    const a = finalize({
      source: 'tcx', sport,
      startTime: startTime ? new Date(startTime).toISOString() : new Date().toISOString(),
      durationSec: totalTime, distanceM: totalDist,
      avgHr: hrTimeWt ? Math.round(hrSum / hrTimeWt) : null,
      maxHr: maxHr || null, calories: calories || null,
      elevationGainM: Math.round(ele) || null,
    }, fileName);
    const m = streamMetrics(stream, sport);
    a.best = m.best; a.decoupling = m.decoupling; a.gapBest = m.gapBest;
    out.push(a);
  }
  if (!out.length) throw new Error('No activities found in TCX file.');
  return out;
}

// ---- GPX --------------------------------------------------------------------

const GPX_SPORT = { running: 'run', run: 'run', cycling: 'bike', biking: 'bike', ride: 'bike', swimming: 'swim', swim: 'swim' };

export function parseGpx(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const trks = [...doc.getElementsByTagName('trk')];
  const out = [];
  for (const trk of trks) {
    const typeEl = trk.getElementsByTagName('type')[0];
    const typeTxt = (typeEl?.textContent || '').toLowerCase();
    let sport = GPX_SPORT[typeTxt] || 'other';
    const pts = [...trk.getElementsByTagName('trkpt')];
    if (!pts.length) continue;
    let dist = 0, ele = 0, prevEle = null, hrSum = 0, hrN = 0, maxHr = 0;
    let firstT = null, lastT = null, prevLat = null, prevLon = null;
    const stream = [];
    for (const pt of pts) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      const tEl = pt.getElementsByTagName('time')[0];
      const t = tEl ? new Date(tEl.textContent) : null;
      if (t) { if (!firstT) firstT = t; lastT = t; }
      const e = txtNum(pt, 'ele');
      if (e != null) { if (prevEle != null && e > prevEle) ele += e - prevEle; prevEle = e; }
      // HR lives in extensions (gpxtpx:hr or ns3:hr).
      const hrEl = pt.getElementsByTagName('hr')[0] ||
        [...pt.getElementsByTagName('*')].find(n => n.localName === 'hr' || n.tagName.endsWith(':hr'));
      let hv = NaN;
      if (hrEl) { hv = parseFloat(hrEl.textContent); if (hv) { hrSum += hv; hrN++; maxHr = Math.max(maxHr, hv); } }
      if (!Number.isNaN(lat) && prevLat != null) dist += haversine(prevLat, prevLon, lat, lon);
      if (!Number.isNaN(lat)) { prevLat = lat; prevLon = lon; }
      if (t) stream.push({ t: t.getTime() / 1000, d: dist, hr: Number.isFinite(hv) ? hv : null, ele: Number.isFinite(e) ? e : null });
    }
    const durationSec = firstT && lastT ? (lastT - firstT) / 1000 : 0;
    const a = finalize({
      source: 'gpx', sport,
      startTime: (firstT || new Date()).toISOString(),
      durationSec, distanceM: Math.round(dist),
      avgHr: hrN ? Math.round(hrSum / hrN) : null,
      maxHr: maxHr || null, calories: null,
      elevationGainM: Math.round(ele) || null,
    }, fileName);
    const m = streamMetrics(stream, sport);
    a.best = m.best; a.decoupling = m.decoupling; a.gapBest = m.gapBest;
    out.push(a);
  }
  if (!out.length) throw new Error('No tracks found in GPX file.');
  return out;
}

// ---- FIT (binary) -----------------------------------------------------------

const FIT_EPOCH = 631065600; // seconds between 1970-01-01 and 1989-12-31 UTC
const FIT_SPORT = { 0: 'other', 1: 'run', 2: 'bike', 5: 'swim', 4: 'other', 11: 'other' };

// base type -> byte size and reader kind
const BASE = {
  0x00: ['u', 1], 0x01: ['i', 1], 0x02: ['u', 1], 0x83: ['i', 2], 0x84: ['u', 2],
  0x85: ['i', 4], 0x86: ['u', 4], 0x07: ['s', 1], 0x88: ['f', 4], 0x89: ['f', 8],
  0x0A: ['u', 1], 0x8B: ['u', 2], 0x8C: ['u', 4], 0x0D: ['u', 1], 0x8E: ['i', 8],
  0x8F: ['u', 8], 0x90: ['u', 8],
};

function isInvalid(kind, size, val) {
  if (val == null) return true;
  if (kind === 'u') { const max = size === 1 ? 0xff : size === 2 ? 0xffff : 0xffffffff; return val === max; }
  if (kind === 'i') { const max = size === 1 ? 0x7f : size === 2 ? 0x7fff : 0x7fffffff; return val === max; }
  return false;
}

export function parseFit(buffer, fileName) {
  const dv = new DataView(buffer);
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== '.FIT') throw new Error('Not a FIT file (bad signature).');
  let pos = headerSize;
  const end = Math.min(headerSize + dataSize, buffer.byteLength);
  const defs = {};
  const sessions = [];
  let timeBase = 0;   // rolling timestamp for compressed-timestamp records
  let recBuf = [];    // record stream accumulated until each session closes

  const readVal = (p, kind, size, le) => {
    let v = null;
    if (kind === 'u') {
      v = size === 1 ? dv.getUint8(p) : size === 2 ? dv.getUint16(p, le) : size === 4 ? dv.getUint32(p, le) : null;
    } else if (kind === 'i') {
      v = size === 1 ? dv.getInt8(p) : size === 2 ? dv.getInt16(p, le) : size === 4 ? dv.getInt32(p, le) : null;
    } else if (kind === 'f') {
      v = size === 4 ? dv.getFloat32(p, le) : dv.getFloat64(p, le);
    }
    return v;
  };

  while (pos < end) {
    const header = dv.getUint8(pos++);
    if (header & 0x80) {
      // compressed timestamp data message — derive full timestamp from 5-bit offset
      const localType = (header >> 5) & 0x03;
      const def = defs[localType];
      if (!def) break;
      const offset = header & 0x1f;
      let ts = (timeBase & ~0x1f) + offset;
      if (offset < (timeBase & 0x1f)) ts += 0x20;
      timeBase = ts;
      pos = readDataMessage(def, pos, ts);
    } else {
      const isDef = (header & 0x40) !== 0;
      const hasDev = (header & 0x20) !== 0;
      const localType = header & 0x0f;
      if (isDef) {
        pos++; // reserved
        const le = dv.getUint8(pos++) === 0;
        const globalNum = dv.getUint16(pos, le); pos += 2;
        const nFields = dv.getUint8(pos++);
        const fields = [];
        for (let i = 0; i < nFields; i++) {
          const num = dv.getUint8(pos++); const size = dv.getUint8(pos++); const baseType = dv.getUint8(pos++);
          fields.push({ num, size, baseType });
        }
        let devTotal = 0;
        if (hasDev) {
          const nDev = dv.getUint8(pos++);
          for (let i = 0; i < nDev; i++) { pos++; const size = dv.getUint8(pos++); pos++; devTotal += size; }
        }
        defs[localType] = { le, globalNum, fields, devTotal };
      } else {
        const def = defs[localType];
        if (!def) break;
        pos = readDataMessage(def, pos, null);
      }
    }
  }

  function readDataMessage(def, p, tsOverride) {
    const vals = {};
    for (const f of def.fields) {
      const meta = BASE[f.baseType];
      if (!meta) { p += f.size; continue; }
      const [kind, unit] = meta;
      if (kind === 's') { p += f.size; continue; } // skip strings
      const raw = readVal(p, kind, unit, def.le);
      p += f.size; // may include array padding; we read first element only
      if (!isInvalid(kind, unit, raw)) vals[f.num] = raw;
    }
    p += def.devTotal;
    if (vals[253] != null) timeBase = vals[253];
    else if (tsOverride != null) vals[253] = tsOverride;
    if (def.globalNum === 20) {
      // record message: accumulate the stream (distance field 5 scale 100, hr field 3)
      const t = vals[253];
      const ele = vals[78] != null ? vals[78] / 5 - 500 : vals[2] != null ? vals[2] / 5 - 500 : null;
      if (t != null) recBuf.push({ t, d: vals[5] != null ? vals[5] / 100 : null, hr: vals[3] != null ? vals[3] : null, ele });
    } else if (def.globalNum === 18) {
      const s = sessionFrom(vals);
      const m = streamMetrics(recBuf, s.sport);
      s.best = m.best; s.decoupling = m.decoupling; s.gapBest = m.gapBest;
      sessions.push(s);
      recBuf = [];
    }
    return p;
  }

  function sessionFrom(v) {
    const sport = FIT_SPORT[v[5]] ?? 'other';
    const startUnix = v[2] != null ? (v[2] + FIT_EPOCH) : null;
    const durationSec = v[8] != null ? v[8] / 1000 : (v[7] != null ? v[7] / 1000 : 0);
    const distanceM = v[9] != null ? v[9] / 100 : null;
    let avgSpeed = v[124] != null ? v[124] / 1000 : (v[14] != null ? v[14] / 1000 : null);
    return finalize({
      source: 'fit', sport,
      startTime: startUnix ? new Date(startUnix * 1000).toISOString() : new Date().toISOString(),
      durationSec, distanceM,
      avgHr: v[16] || null, maxHr: v[17] || null, calories: v[11] || null,
      avgSpeed, elevationGainM: null,
    }, fileName);
  }

  if (!sessions.length) throw new Error('No session summary found in FIT file (unusual — try the TCX export instead).');
  return sessions;
}

// ---- tiny XML helpers -------------------------------------------------------

function childOf(el, tag) { return el ? el.getElementsByTagName(tag)[0] : null; }
function num(el, tag) {
  if (!el) return null;
  const c = el.getElementsByTagName(tag)[0];
  if (!c) return null;
  const n = parseFloat(c.textContent);
  return Number.isNaN(n) ? null : n;
}
function txtNum(el, tag) {
  const c = el.getElementsByTagName(tag)[0];
  if (!c) return null;
  const n = parseFloat(c.textContent);
  return Number.isNaN(n) ? null : n;
}

// Exposed for unit tests only.
export const _internal = { meanMax, windowsBest };
