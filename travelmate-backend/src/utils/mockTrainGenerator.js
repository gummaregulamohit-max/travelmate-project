// Generates 3-5 realistic-looking scheduled train options for ANY station-code
// pair, instead of relying on a hardcoded list of routes. Mirrors the approach
// in mockFlightGenerator.js: results are seeded from origin+destination+date,
// so repeat searches for the same route/date are stable rather than
// re-randomizing on every call.
//
// Not used for train search: /api/trains/search never returns generated
// trains (it reports no trains instead). Only estimateClassFare is used, by
// routes/trains.routes.js.

const { findStationByCode } = require('../services/stations.service');

// ---- seeded RNG (mulberry32), same scheme as mockFlightGenerator.js ----
function seedFromString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

function randInt(rng, min, max) {
  return Math.floor(randRange(rng, min, max + 1));
}

function minutesToClock(totalMinutesFromMidnight) {
  const wrapped = ((totalMinutesFromMidnight % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.round(wrapped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function daysElapsed(depMinutes, durationMinutes) {
  return Math.floor((depMinutes + durationMinutes) / 1440);
}

const NAME_TEMPLATES = [
  (o, d) => `${d} Express`,
  (o, d) => `${d} Superfast Express`,
  (o, d) => `${d} Mail Express`,
  (o, d) => `${o} - ${d} SF Express`,
  (o, d) => `${d} Duronto Express`,
  (o, d) => `${d} Garib Rath Express`,
  (o, d) => `${d} Rajdhani Express`,
  (o, d) => `${d} Vande Bharat Express`
];

// Rajdhani/Vande Bharat/Duronto are premium named services — only offer them
// with low probability so most results read as ordinary Express/Superfast trains.
const PREMIUM_TEMPLATE_INDEXES = new Set([4, 5, 6, 7]);

function trainNameFor(rng, originLabel, destLabel) {
  let index = randInt(rng, 0, NAME_TEMPLATES.length - 1);
  if (PREMIUM_TEMPLATE_INDEXES.has(index) && rng() > 0.25) {
    index = randInt(rng, 0, 3); // fall back to a regular Express/Mail/SF name
  }
  return NAME_TEMPLATES[index](originLabel, destLabel);
}

function trainNumberFor(rng) {
  return String(randInt(rng, 10000, 99999));
}

const STATUS_POOL = [
  { status: 'Available', tier: 'available', weight: 0.55 },
  { status: 'RAC', tier: 'rac', weight: 0.2 },
  { status: 'WL', tier: 'wl', weight: 0.25 }
];

function statusFor(rng) {
  const roll = rng();
  let cumulative = 0;
  for (const entry of STATUS_POOL) {
    cumulative += entry.weight;
    if (roll <= cumulative) {
      if (entry.tier === 'available') return { status: 'Available', tier: 'available' };
      return { status: `${entry.status} ${randInt(rng, 1, 40)}`, tier: entry.tier };
    }
  }
  return { status: 'Available', tier: 'available' };
}

// Per-class base fare + per-hour rate (INR), roughly proportional to real IRCTC pricing tiers.
const CLASS_RATES = [
  { cls: 'SL', base: 60, perHour: 14 },
  { cls: '3A', base: 180, perHour: 38 },
  { cls: '2A', base: 260, perHour: 55 },
  { cls: '1A', base: 420, perHour: 90 }
];

function classesFor(rng, durationHours) {
  return CLASS_RATES.map(({ cls, base, perHour }) => {
    const jitter = randRange(rng, 0.9, 1.15);
    const fare = Math.round(((base + perHour * durationHours) * jitter) / 5) * 5;
    return { cls, fare, ...statusFor(rng) };
  });
}

// Deterministic (no RNG) fare estimate for one class, used to fill in a class
// the live IRCTC API couldn't return a fare for (rate-limited, etc.) without
// pretending it's a real quote — callers should flag these as estimated.
function estimateClassFare(cls, durationMinutes) {
  const rate = CLASS_RATES.find((r) => r.cls === cls) || CLASS_RATES[0];
  const fare = Math.round((rate.base + rate.perHour * (durationMinutes / 60)) / 5) * 5;
  return fare;
}

function stationLabel(code) {
  const station = findStationByCode(code);
  return station ? `${station.name} (${station.code})` : code;
}

function cityLabel(code) {
  const station = findStationByCode(code);
  return (station && station.city) || code;
}

/**
 * Generates 3-5 mock scheduled trains for any origin/destination station-code pair.
 * @param {{from: string, to: string, date?: string, hasRetiringRoomFrom?: boolean, hasRetiringRoomTo?: boolean}} params
 */
function generateMockTrains({ from, to, date, hasRetiringRoomFrom, hasRetiringRoomTo }) {
  const seed = seedFromString(`${from}->${to}->${date || ''}`);
  const rng = mulberry32(seed);

  const originLabel = cityLabel(from);
  const destLabel = cityLabel(to);
  const hasRetiringRoom = !!(hasRetiringRoomFrom || hasRetiringRoomTo);

  const count = randInt(rng, 3, 5);
  const usedNumbers = new Set();
  const usedDepartureSlots = [];

  const trains = Array.from({ length: count }).map(() => {
    let trainNumber = trainNumberFor(rng);
    while (usedNumbers.has(trainNumber)) trainNumber = trainNumberFor(rng);
    usedNumbers.add(trainNumber);

    // Long-distance-feeling durations (2h30m to 28h), spread across the day.
    const durationMinutes = randInt(rng, 150, 1680);

    let depMinutes = randInt(rng, 0, 1439);
    let attempts = 0;
    while (usedDepartureSlots.some((m) => Math.abs(m - depMinutes) < 45) && attempts < 20) {
      depMinutes = randInt(rng, 0, 1439);
      attempts++;
    }
    usedDepartureSlots.push(depMinutes);

    const arrMinutes = depMinutes + durationMinutes;
    const extraDays = daysElapsed(depMinutes, durationMinutes);
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;

    return {
      trainNumber,
      trainName: trainNameFor(rng, originLabel, destLabel),
      fromStation: stationLabel(from),
      toStation: stationLabel(to),
      departureTime: minutesToClock(depMinutes),
      arrivalTime: minutesToClock(arrMinutes) + (extraDays > 0 ? ` (+${extraDays})` : ''),
      durationMinutes,
      duration: `${hours}h ${String(mins).padStart(2, '0')}m`,
      days: rng() < 0.8 ? 'Runs Daily' : 'Runs 6 days a week (except Tue)',
      classes: classesFor(rng, durationMinutes / 60),
      hasRetiringRoom
    };
  });

  return trains.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

module.exports = { generateMockTrains, estimateClassFare };
