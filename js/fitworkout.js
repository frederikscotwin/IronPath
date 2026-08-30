// fitworkout.js — build a structured workout and export it as a Garmin FIT
// workout file (importable in Garmin Connect → Workouts). Also exports JSON and
// human-readable text as reliable fallbacks. The encoder is spec-faithful and
// round-trip-validated by decodeWorkoutFit; still, check your first real import.

const FIT_EPOCH = 631065600;
const SPORT = { run: 1, bike: 2, swim: 5, other: 0, strength: 10 };
const SPORT_REV = { 1: 'run', 2: 'bike', 5: 'swim', 0: 'other', 10: 'strength' };
const INTENSITY = { active: 0, rest: 1, warmup: 2, cooldown: 3 };
const DURATION = { time: 0, distance: 1, open: 5 };
const TARGET = { pace: 0, hr: 1, open: 2 };

// ---- FIT CRC (needed for a file Garmin will accept) -------------------------
const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
  0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
function fitCrc(bytes) {
  let crc = 0;
  for (const b of bytes) {
    let t = CRC_TABLE[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[b & 0xF];
    t = CRC_TABLE[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[(b >> 4) & 0xF];
  }
  return crc & 0xFFFF;
}

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v) => { v = v >>> 0; return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; };
function str(s, len) { const b = new Array(len).fill(0); s = String(s || ''); for (let i = 0; i < Math.min(len - 1, s.length); i++) b[i] = s.charCodeAt(i) & 0x7f; return b; }

function defRecord(local, global, fields) {
  const b = [0x40 | local, 0x00, 0x00, ...u16(global), fields.length];
  for (const f of fields) b.push(f.num, f.size, f.base);
  return b;
}
function dataRecord(local, fields) {
  const b = [local];
  for (const f of fields) {
    if (f.base === 0x07) b.push(...str(f.value, f.size));
    else if (f.size === 1) b.push((f.value | 0) & 0xff);
    else if (f.size === 2) b.push(...u16(f.value | 0));
    else b.push(...u32(f.value | 0));
  }
  return b;
}

// workout = { name, sport, steps:[{name,intensity,durationType,durationValue,
//   target:{type:'hr'|'pace'|'open', lo, hi}}] }  durationValue: sec | meters.
export function buildWorkoutFit(workout) {
  const steps = workout.steps || [];
  const data = [];

  // file_id (global 0): type=workout(5)
  data.push(...defRecord(0, 0, [{ num: 0, size: 1, base: 0x00 }, { num: 1, size: 2, base: 0x84 }, { num: 2, size: 2, base: 0x84 }, { num: 4, size: 4, base: 0x86 }]));
  const now = Math.floor(Date.now() / 1000) - FIT_EPOCH;
  data.push(...dataRecord(0, [{ size: 1, base: 0x00, value: 5 }, { size: 2, base: 0x84, value: 255 }, { size: 2, base: 0x84, value: 0 }, { size: 4, base: 0x86, value: now }]));

  // workout (global 26)
  data.push(...defRecord(1, 26, [{ num: 8, size: 16, base: 0x07 }, { num: 4, size: 1, base: 0x00 }, { num: 6, size: 2, base: 0x84 }]));
  data.push(...dataRecord(1, [{ size: 16, base: 0x07, value: workout.name || 'IronPath' }, { size: 1, base: 0x00, value: SPORT[workout.sport] ?? 0 }, { size: 2, base: 0x84, value: steps.length }]));

  // workout_step (global 27), one definition then N data records
  const sFields = [
    { num: 254, size: 2, base: 0x84 }, { num: 0, size: 16, base: 0x07 },
    { num: 1, size: 1, base: 0x00 }, { num: 2, size: 4, base: 0x86 },
    { num: 3, size: 1, base: 0x00 }, { num: 4, size: 4, base: 0x86 },
    { num: 5, size: 4, base: 0x86 }, { num: 6, size: 4, base: 0x86 }, { num: 7, size: 1, base: 0x00 },
  ];
  data.push(...defRecord(2, 27, sFields));
  steps.forEach((st, i) => {
    const durType = DURATION[st.durationType] ?? 5;
    const durVal = st.durationType === 'time' ? Math.round((st.durationValue || 0) * 1000)
      : st.durationType === 'distance' ? Math.round((st.durationValue || 0) * 100) : 0;
    let tType = TARGET[st.target?.type] ?? 2, lo = 0, hi = 0;
    if (st.target?.type === 'hr') { lo = Math.round(st.target.lo) + 100; hi = Math.round(st.target.hi) + 100; } // >100 = absolute bpm
    else if (st.target?.type === 'pace') { lo = Math.round(st.target.lo * 1000); hi = Math.round(st.target.hi * 1000); } // m/s×1000
    data.push(...dataRecord(2, [
      { size: 2, base: 0x84, value: i }, { size: 16, base: 0x07, value: st.name },
      { size: 1, base: 0x00, value: durType }, { size: 4, base: 0x86, value: durVal },
      { size: 1, base: 0x00, value: tType }, { size: 4, base: 0x86, value: 0 },
      { size: 4, base: 0x86, value: lo }, { size: 4, base: 0x86, value: hi }, { size: 1, base: 0x00, value: INTENSITY[st.intensity] ?? 0 },
    ]));
  });

  const header = [14, 0x20, ...u16(2100), ...u32(data.length), 0x2E, 0x46, 0x49, 0x54, 0, 0];
  // 14-byte header carries its own CRC (over first 12 bytes)
  const hcrc = fitCrc(header.slice(0, 12));
  header[12] = hcrc & 0xff; header[13] = (hcrc >> 8) & 0xff;
  const all = header.concat(data);
  const crc = fitCrc(all);
  return new Uint8Array(all.concat([crc & 0xff, (crc >> 8) & 0xff]));
}

// Minimal decoder to round-trip-validate the encoder.
export function decodeWorkoutFit(buffer) {
  const dv = new DataView(buffer);
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  let pos = headerSize;
  const end = headerSize + dataSize;
  const defs = {};
  let name = '', sport = null, numSteps = null;
  const steps = [];
  while (pos < end) {
    const h = dv.getUint8(pos++);
    if (h & 0x80) continue;
    const isDef = (h & 0x40) !== 0, local = h & 0x0f;
    if (isDef) {
      pos++; const le = dv.getUint8(pos++) === 0; const g = dv.getUint16(pos, le); pos += 2;
      const nf = dv.getUint8(pos++); const fields = [];
      for (let i = 0; i < nf; i++) { const num = dv.getUint8(pos++), size = dv.getUint8(pos++), base = dv.getUint8(pos++); fields.push({ num, size, base }); }
      let dev = 0; if (h & 0x20) { const nd = dv.getUint8(pos++); for (let i = 0; i < nd; i++) { pos++; dev += dv.getUint8(pos++); pos++; } }
      defs[local] = { le, g, fields, dev };
    } else {
      const def = defs[local]; if (!def) break;
      const vals = {}, strs = {};
      for (const f of def.fields) {
        if (f.base === 0x07) { let s = ''; for (let k = 0; k < f.size; k++) { const c = dv.getUint8(pos + k); if (c) s += String.fromCharCode(c); } strs[f.num] = s; pos += f.size; }
        else { let v = null; if (f.size === 1) v = dv.getUint8(pos); else if (f.size === 2) v = dv.getUint16(pos, def.le); else if (f.size === 4) v = dv.getUint32(pos, def.le); pos += f.size; vals[f.num] = v; }
      }
      pos += def.dev;
      if (def.g === 26) { name = strs[8] || ''; sport = SPORT_REV[vals[4]] ?? vals[4]; numSteps = vals[6]; }
      else if (def.g === 27) steps.push({ intensity: vals[7], durationType: vals[1], durationValue: vals[2], targetType: vals[3], lo: vals[5], hi: vals[6] });
    }
  }
  return { name, sport, numSteps, steps };
}

// Build a structured workout from a plan session's intent + threshold HR.
export function generateWorkoutFromSession(session, lthr, settings) {
  const sport = session.sport || 'run';
  const totalMin = Math.round((session.targetDurationSec || 3600) / 60);
  const r = session.targetReserve ?? 0.65;
  const title = (session.title || '').toLowerCase();
  const hrBand = (lo, hi) => lthr ? { type: 'hr', lo: Math.round(lthr * lo), hi: Math.round(lthr * hi) } : { type: 'open' };
  const steps = [];
  const wu = Math.min(15, Math.max(8, Math.round(totalMin * 0.2)));
  const cd = Math.min(10, Math.max(5, Math.round(totalMin * 0.12)));
  steps.push({ name: 'Warm-up', intensity: 'warmup', durationType: 'time', durationValue: wu * 60, target: hrBand(0.65, 0.75) });

  const isInterval = /interval|threshold|css|tempo|×|x\d|vo2|sharp/.test(title) || r >= 0.75;
  const mainMin = totalMin - wu - cd;
  if (isInterval && mainMin >= 12) {
    // e.g. threshold reps: 5×5 min hard / 2 min easy (fit to available time)
    const repMin = r >= 0.85 ? 3 : 5, restMin = 2;
    const reps = Math.max(3, Math.min(8, Math.floor(mainMin / (repMin + restMin))));
    for (let i = 0; i < reps; i++) {
      steps.push({ name: `Interval ${i + 1}`, intensity: 'active', durationType: 'time', durationValue: repMin * 60, target: hrBand(0.95, 1.0) });
      if (i < reps - 1) steps.push({ name: 'Easy', intensity: 'rest', durationType: 'time', durationValue: restMin * 60, target: hrBand(0.65, 0.75) });
    }
  } else {
    steps.push({ name: 'Steady', intensity: 'active', durationType: 'time', durationValue: Math.max(1, mainMin) * 60, target: hrBand(r - 0.08, r + 0.04) });
  }
  steps.push({ name: 'Cool-down', intensity: 'cooldown', durationType: 'time', durationValue: cd * 60, target: hrBand(0.6, 0.68) });
  return { name: (session.title || `${cap(sport)} session`).slice(0, 15), sport, steps };
}

export function workoutToText(w) {
  const dur = (s) => s.durationType === 'time' ? `${Math.round(s.durationValue / 60)} min` : s.durationType === 'distance' ? `${s.durationValue} m` : 'open';
  const tgt = (s) => s.target?.type === 'hr' ? `HR ${s.target.lo}–${s.target.hi}` : s.target?.type === 'pace' ? `pace target` : 'free';
  return `${w.name} (${w.sport})\n` + w.steps.map((s, i) => `${i + 1}. [${s.intensity}] ${s.name} — ${dur(s)} @ ${tgt(s)}`).join('\n');
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
