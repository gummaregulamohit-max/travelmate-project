// Generates 6-10 realistic-looking scheduled intercity bus options for ANY
// origin/destination city pair, covering both government RTCs and private
// operators. Mirrors the seeded-RNG approach in mockTrainGenerator.js /
// mockFlightGenerator.js: results are seeded from origin+destination+date, so
// repeat searches for the same route/date are stable rather than
// re-randomizing on every call.

const { knownBusPoints } = require('../data/busPoints');

// ---- seeded RNG (mulberry32), same scheme as mockTrainGenerator.js ----
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

// Government RTCs and private operators, each with a few realistic
// sub-brand/bus-type variants. `portal` (govt only) links to the RTC's own
// booking site; private operators are booked via a RedBus city-pair deep link.
const OPERATOR_PROFILES = [
  {
    key: 'KSRTC', isGovt: true, portal: 'https://ksrtc.in',
    variants: [
      { name: 'KSRTC Airavat Club Class', busType: 'AC Multi-Axle Sleeper (2+1)' },
      { name: 'KSRTC Ambaari Dream Class', busType: 'AC Sleeper (2+1)' },
      { name: 'KSRTC Rajahamsa', busType: 'AC Seater (2+2)' },
      { name: 'KSRTC', busType: 'Non-AC Sleeper (2+1)' }
    ]
  },
  {
    key: 'TSRTC', isGovt: true, portal: 'https://www.tsrtc.in',
    variants: [
      { name: 'TSRTC Garuda Plus', busType: 'AC Multi-Axle Sleeper (2+1)' },
      { name: 'TSRTC Indra AC Sleeper', busType: 'AC Sleeper (2+1)' },
      { name: 'TSRTC Super Luxury', busType: 'Non-AC Seater (2+3)' }
    ]
  },
  {
    key: 'APSRTC', isGovt: true, portal: 'https://www.apsrtc.gov.in',
    variants: [
      { name: 'APSRTC Super Luxury', busType: 'AC Seater (2+2)' },
      { name: 'APSRTC Indra AC Sleeper', busType: 'AC Sleeper (2+1)' },
      { name: 'APSRTC', busType: 'Non-AC Seater Express' }
    ]
  },
  {
    key: 'MSRTC', isGovt: true, portal: 'https://msrtc.maharashtra.gov.in',
    variants: [
      { name: 'MSRTC Shivneri', busType: 'AC Seater (2+2)' },
      { name: 'MSRTC Shivshahi', busType: 'Non-AC Seater (2+3)' },
      { name: 'MSRTC', busType: 'Non-AC Sleeper' }
    ]
  },
  {
    key: 'VRL', isGovt: false,
    variants: [
      { name: 'VRL Travels', busType: 'Multi-Axle AC Sleeper (2+1)' },
      { name: 'VRL Travels', busType: 'Scania AC Seater' }
    ]
  },
  {
    key: 'Orange', isGovt: false,
    variants: [
      { name: 'Orange Tours & Travels', busType: 'AC Sleeper (2+1)' },
      { name: 'Orange Tours & Travels', busType: 'Multi-Axle AC Sleeper' }
    ]
  },
  {
    key: 'SRS', isGovt: false,
    variants: [
      { name: 'SRS Travels', busType: 'Scania AC Seater' },
      { name: 'SRS Travels', busType: 'AC Sleeper (2+1)' }
    ]
  },
  {
    key: 'Zingbus', isGovt: false,
    variants: [
      { name: 'Zingbus', busType: 'AC Sleeper (2+1)' },
      { name: 'Zingbus', busType: 'AC Seater Pushback' }
    ]
  },
  {
    key: 'IntrCity', isGovt: false,
    variants: [
      { name: 'IntrCity SmartBus', busType: 'AC Sleeper Primo (2+1)' },
      { name: 'IntrCity SmartBus', busType: 'AC Seater Primo' }
    ]
  }
];

// Boarding / dropping points come from data/busPoints.js — the same list the
// location directory returns — so a point picked in the From / To dropdown is
// one these buses actually stop at. A city without hand-listed points falls
// back to a generic-but-plausible set built from the city name itself, so the
// search never comes back empty.
function boardingPointsFor(city) {
  const known = knownBusPoints(city);
  if (known) return known;
  const label = (city || 'City').trim();
  return [`${label} Central Bus Stand`, `${label} Highway Junction`, `${label} City Bus Terminal`];
}

function slugify(city) {
  return (city || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function redbusUrl(fromCity, toCity) {
  return `https://www.redbus.in/bus-tickets/${slugify(fromCity)}-to-${slugify(toCity)}`;
}

function fareRangeFor(profile, busType) {
  const typeLower = busType.toLowerCase();
  if (!profile.isGovt) {
    if (typeLower.includes('sleeper') || typeLower.includes('multi-axle')) return { min: 950, max: 1800 };
    return { min: 750, max: 1300 };
  }
  if (typeLower.includes('non-ac')) return { min: 650, max: 950 };
  if (typeLower.includes('sleeper')) return { min: 800, max: 1400 };
  return { min: 700, max: 1100 };
}

const AMENITY_POOL = ['WiFi', 'Charging Point', 'Water Bottle', 'Blanket', 'Live Tracking', 'CCTV', 'Reading Light'];

function amenitiesFor(rng, profile, busType) {
  const pool = [...AMENITY_POOL];
  // Non-AC/government seater buses realistically skip WiFi/blanket.
  const typeLower = busType.toLowerCase();
  const filtered = typeLower.includes('non-ac')
    ? pool.filter((a) => a !== 'WiFi' && a !== 'Blanket')
    : pool;
  const count = randInt(rng, 3, Math.min(5, filtered.length));
  const shuffled = [...filtered].sort(() => rng() - 0.5);
  return shuffled.slice(0, count);
}

function pickPoints(rng, points, count) {
  const shuffled = [...points].sort(() => rng() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Generates 6-10 mock scheduled intercity buses for any origin/destination city pair.
 * @param {{from: string, to: string, date?: string}} params
 */
function generateMockBuses({ from, to, date }) {
  const seed = seedFromString(`${from}->${to}->${date || ''}`);
  const rng = mulberry32(seed);

  const fromPoints = boardingPointsFor(from);
  const toPoints = boardingPointsFor(to);

  const count = randInt(rng, 6, 10);
  const usedDepartureSlots = [];
  const usedCombos = new Set();

  const buses = Array.from({ length: count }).map((_, i) => {
    let profile = pick(rng, OPERATOR_PROFILES);
    let variant = pick(rng, profile.variants);
    let combo = `${profile.key}:${variant.busType}`;
    let attempts = 0;
    while (usedCombos.has(combo) && attempts < 10) {
      profile = pick(rng, OPERATOR_PROFILES);
      variant = pick(rng, profile.variants);
      combo = `${profile.key}:${variant.busType}`;
      attempts++;
    }
    usedCombos.add(combo);

    // Intercity bus journeys, spread across the day with slots at least ~40m apart.
    const durationMinutes = randInt(rng, 240, 840);
    let depMinutes = randInt(rng, 0, 1439);
    let slotAttempts = 0;
    while (usedDepartureSlots.some((m) => Math.abs(m - depMinutes) < 40) && slotAttempts < 20) {
      depMinutes = randInt(rng, 0, 1439);
      slotAttempts++;
    }
    usedDepartureSlots.push(depMinutes);

    const arrMinutes = depMinutes + durationMinutes;
    const extraDays = daysElapsed(depMinutes, durationMinutes);
    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;

    const { min, max } = fareRangeFor(profile, variant.busType);
    const fare = Math.round(randRange(rng, min, max) / 10) * 10;

    const rating = profile.isGovt
      ? Math.round(randRange(rng, 3.5, 4.3) * 10) / 10
      : Math.round(randRange(rng, 3.8, 4.8) * 10) / 10;

    return {
      id: `bus-${slugify(from)}-${slugify(to)}-${i + 1}`,
      operatorName: variant.name,
      isGovt: profile.isGovt,
      busType: variant.busType,
      departureTime: minutesToClock(depMinutes),
      arrivalTime: minutesToClock(arrMinutes) + (extraDays > 0 ? ` (+${extraDays})` : ''),
      duration: `${hours}h ${String(mins).padStart(2, '0')}m`,
      boardingPoints: pickPoints(rng, fromPoints, randInt(rng, 3, Math.min(4, fromPoints.length))),
      droppingPoints: pickPoints(rng, toPoints, randInt(rng, 3, Math.min(4, toPoints.length))),
      fare,
      rating,
      seatsAvailable: randInt(rng, 4, 42),
      amenities: amenitiesFor(rng, profile, variant.busType),
      bookingUrl: profile.isGovt ? profile.portal : redbusUrl(from, to)
    };
  });

  return buses.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

module.exports = { generateMockBuses };
