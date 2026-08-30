// race.js — race-day execution: per-leg pacing targets and a fuelling sheet.
// Built from the same estimated thresholds and finish projection the Coach uses.

const clock = (sec) => { if (!sec || !isFinite(sec)) return '—'; const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; };
const hms = (sec) => { if (!sec) return '—'; sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };

// Per-leg HR target from threshold HR (Ironman intensities: swim & run aerobic,
// bike a touch higher but still controlled).
function hrBand(lthr, lo, hi) { return lthr ? `${Math.round(lthr * lo)}–${Math.round(lthr * hi)}` : '—'; }

export function racePlan(pred, est, settings, weightKg) {
  const im = pred.ironman;
  if (!im) return null;
  const lthr = est.lthr.value;
  const swimSec = im.swimSec || 0, bikeSec = im.bikeSec, runSec = im.runSec;
  const bikeRunHours = (bikeSec + runSec) / 3600;

  const pacing = [
    { leg: 'Swim · 3.8 km', time: hms(swimSec), target: est.cssSpeed.value ? `${clock(100 / (est.cssSpeed.value / settings.imSwimFactor))} /100m` : '—', hr: `${hrBand(lthr, 0.78, 0.85)} bpm`, cue: 'Smooth, sit on feet, save the legs.' },
    { leg: 'Bike · 180 km', time: hms(bikeSec), target: `${im.bikeKmh.toFixed(1)} km/h`, hr: `${hrBand(lthr, 0.82, 0.90)} bpm`, cue: 'Ride your own number; eat and drink on the bike.' },
    { leg: 'Run · 42.2 km', time: hms(runSec), target: `${clock(im.marathonPacePerKm)} /km`, hr: `${hrBand(lthr, 0.85, 0.92)} bpm`, cue: 'Start easier than feels right; hold form as fatigue rises.' },
  ];

  const carbs = settings.fuelCarbsPerHr, fluid = settings.fuelFluidMlPerHr, sodium = settings.fuelSodiumMgPerHr;
  // rough energy burn: run ~1 kcal/kg/km, bike ~ time-based, swim modest
  const runKcal = weightKg * 42.195 * 1.0;
  const bikeKcal = (bikeSec / 3600) * 600;
  const swimKcal = (swimSec / 3600) * 500;
  const totalKcal = Math.round(runKcal + bikeKcal + swimKcal);

  const fuelling = {
    perHour: { carbs, fluidMl: fluid, sodiumMg: sodium },
    totals: {
      carbsG: Math.round(carbs * bikeRunHours),
      fluidMl: Math.round(fluid * bikeRunHours),
      sodiumMg: Math.round(sodium * bikeRunHours),
      carbsKcal: Math.round(carbs * bikeRunHours * 4),
    },
    estimatedBurnKcal: totalKcal,
    note: 'Carbs/fluid/sodium are per hour of bike+run (little goes in during the swim). 60–90 g carbs/hr needs a trained gut — practise it in long sessions.',
  };

  return { totalTime: hms(im.total), pacing, fuelling, bikeRunHours: +bikeRunHours.toFixed(1) };
}

export { clock as _clock, hms as _hms };
