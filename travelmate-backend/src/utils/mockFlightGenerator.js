// Generates 4–6 realistic-looking flight options for ANY origin/destination
// IATA pair, instead of relying on a hardcoded list of routes. Used as the
// fallback when the live Amadeus API is unavailable, unconfigured, or errors
// out — so /api/flights/search always returns something sensible.
//
// Results are seeded from origin+destination+date, so repeat searches for
// the same route/date are stable rather than re-randomizing on every call.

const airports = require('../data/airports.json');
const { COUNTRY_CARRIERS, GLOBAL_HUB_CARRIERS } = require('../data/carriers');

const airportsByCode = new Map(airports.map((a) => [a.code, a]));

const MOCK_AIRCRAFT = ['Airbus A320', 'Airbus A321', 'Boeing 737', 'Boeing 787', 'Airbus A350', 'Boeing 777'];

// ---- seeded RNG (mulberry32) so a given route+date always looks the same ----
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

function pickUnique(rng, arr, count) {
  const pool = [...arr];
  const out = [];
  while (pool.length && out.length < count) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

function classifyRoute(originCode, destinationCode) {
  const o = airportsByCode.get(originCode);
  const d = airportsByCode.get(destinationCode);
  if (o && d && o.country === d.country) return 'domestic';
  if (o && d && o.continent === d.continent) return 'regional';
  return 'intercontinental'; // also the default when an airport isn't in our dataset
}

// Some countries/continents are geographically huge, so "domestic" or
// "same continent" alone understates real flight times (e.g. Delhi–Chennai
// vs. NYC–LA are both "domestic", but very different durations; Dubai–Tokyo
// and Istanbul–Bangkok are both "same continent" (Asia) but far apart). We
// don't have airport coordinates to compute real distance, so this is a
// coarse size-aware approximation rather than true great-circle timing.
const LARGE_COUNTRIES = new Set(['India', 'United States', 'China', 'Australia', 'Brazil', 'Canada', 'Russia', 'Indonesia']);
const LARGE_CONTINENTS = new Set(['Asia', 'Africa', 'North America']);

function durationRangeFor(tier, originCode, destinationCode) {
  const o = airportsByCode.get(originCode);
  const d = airportsByCode.get(destinationCode);

  if (tier === 'domestic') {
    return LARGE_COUNTRIES.has(o && o.country) ? [60, 360] : [45, 150];
  }
  if (tier === 'regional') {
    const continent = (o && o.continent) || (d && d.continent);
    return LARGE_CONTINENTS.has(continent) ? [120, 480] : [90, 300];
  }
  return [360, 1020]; // intercontinental
}

// Rough elapsed-flight-time ranges (minutes, resolved per-route by durationRangeFor)
// and stop probability / price band per tier.
const TIER_PROFILES = {
  domestic: { nonstopChance: 0.85, priceRange: [2800, 7500] },
  regional: { nonstopChance: 0.65, priceRange: [7000, 22000] },
  intercontinental: { nonstopChance: 0.35, priceRange: [28000, 85000] }
};

function carrierPoolFor(originCode, destinationCode, tier) {
  const o = airportsByCode.get(originCode);
  const d = airportsByCode.get(destinationCode);
  const pool = [];

  if (o && COUNTRY_CARRIERS[o.country]) pool.push(...COUNTRY_CARRIERS[o.country]);
  if (d && COUNTRY_CARRIERS[d.country] && d.country !== (o && o.country)) pool.push(...COUNTRY_CARRIERS[d.country]);

  if (tier !== 'domestic') {
    // Add global hub carriers so intercontinental/regional routes have
    // plausible connecting options even when neither country has a mapped carrier.
    pool.push(...GLOBAL_HUB_CARRIERS.slice(0, 3));
  }

  // Long-haul distances rule out short-haul/budget carriers (e.g. IndiGo,
  // SpiceJet, Air Arabia don't operate intercontinental widebody flights).
  const filtered = tier === 'intercontinental' ? pool.filter((c) => c.longHaul) : pool;

  // De-dupe by slug, keep at least 2 options even for totally unmapped countries.
  const seen = new Set();
  const deduped = filtered.filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
  return deduped.length ? deduped : GLOBAL_HUB_CARRIERS;
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

function flightNumberFor(rng, slug) {
  const prefixMap = {
    indigo: '6E', 'air-india': 'AI', akasa: 'QP', spicejet: 'SG', emirates: 'EK',
    etihad: 'EY', 'air-arabia': 'G9', qatar: 'QR', united: 'UA', delta: 'DL',
    american: 'AA', 'british-airways': 'BA', 'virgin-atlantic': 'VS', lufthansa: 'LH',
    'air-france': 'AF', klm: 'KL', 'singapore-airlines': 'SQ', qantas: 'QF',
    ana: 'NH', jal: 'JL', 'china-southern': 'CZ', 'china-eastern': 'MU',
    'turkish-airlines': 'TK', 'thai-airways': 'TG', 'korean-air': 'KE',
    'air-canada': 'AC', saudia: 'SV', 'malaysia-airlines': 'MH',
    'garuda-indonesia': 'GA', swiss: 'LX', 'ita-airways': 'AZ', iberia: 'IB',
    'south-african-airways': 'SA', egyptair: 'MS', 'kenya-airways': 'KQ',
    'air-nz': 'NZ', latam: 'LA', 'oman-air': 'WY', 'gulf-air': 'GF', 'kuwait-airways': 'KU'
  };
  const prefix = prefixMap[slug] || slug.slice(0, 2).toUpperCase();
  const num = Math.floor(randRange(rng, 100, 999));
  return `${prefix}-${num}`;
}

/**
 * Generates 4–6 mock flight offers for any origin/destination pair.
 * @param {{origin: string, destination: string, date?: string, cabinClass?: string}} params
 * @returns {Array} flights in the same shape transformFlightOffers.js produces
 */
function generateMockFlights({ origin, destination, date, cabinClass }) {
  const seed = seedFromString(`${origin}->${destination}->${date || ''}`);
  const rng = mulberry32(seed);

  const tier = classifyRoute(origin, destination);
  const profile = TIER_PROFILES[tier];
  const durationRange = durationRangeFor(tier, origin, destination);
  const carriers = carrierPoolFor(origin, destination, tier);

  const originAirport = airportsByCode.get(origin);
  const destAirport = airportsByCode.get(destination);
  const hubOptions = GLOBAL_HUB_CARRIERS.filter((h) => h.hub.indexOf(`(${origin})`) === -1 && h.hub.indexOf(`(${destination})`) === -1);

  const count = 4 + Math.floor(rng() * 3); // 4, 5, or 6
  const flightsCount = Math.min(count, 6);
  const chosenCarriers = pickUnique(rng, carriers, Math.min(flightsCount, carriers.length));
  // If we need more flights than distinct carriers, some airlines fly multiple times a day.
  while (chosenCarriers.length < flightsCount) chosenCarriers.push(pick(rng, carriers));

  const flights = chosenCarriers.slice(0, flightsCount).map((carrier, i) => {
    const isNonstop = rng() < profile.nonstopChance;
    const baseDuration = Math.round(randRange(rng, durationRange[0], durationRange[1]));
    const layoverMinutes = isNonstop ? 0 : Math.round(randRange(rng, 75, 210));
    const durationMinutes = isNonstop ? baseDuration : baseDuration + layoverMinutes;

    // Spread departures roughly across the day, with jitter.
    const depMinutes = Math.round((i / flightsCount) * 1440 + randRange(rng, -60, 60) + 300);
    const arrMinutes = depMinutes + durationMinutes;
    const extraDays = daysElapsed(depMinutes, durationMinutes);

    const hours = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;

    const stopHub = !isNonstop ? pick(rng, hubOptions.length ? hubOptions : GLOBAL_HUB_CARRIERS) : null;
    const stopCity = stopHub ? stopHub.hub : null;
    const stopCode = stopHub ? (stopHub.hub.match(/\(([A-Z]{3})\)/) || [])[1] : null;
    const stopCityName = stopHub ? stopHub.hub.replace(/\s*\([A-Z]{3}\)\s*$/, '') : null;

    const priceBase = randRange(rng, profile.priceRange[0], profile.priceRange[1]);
    const priceAdj = isNonstop ? priceBase * 1.12 : priceBase * 0.92; // nonstop commands a premium
    const price = Math.round(priceAdj / 100) * 100; // round to nearest 100

    const flightNumber = flightNumberFor(rng, carrier.slug);
    const aircraft = pick(rng, MOCK_AIRCRAFT);
    const legroom = `${Math.round(randRange(rng, 71, 86))} cm`;

    // Per-segment breakdown for the expandable itinerary view. Nonstop = one
    // segment matching the overall times; 1-stop splits baseDuration roughly
    // 40/60 across the two legs (the second, often-international leg tends
    // to be the longer one on a real hub-and-spoke routing).
    let flightSegments;
    if (isNonstop) {
      flightSegments = [{
        airline: carrier.name, flightNumber, aircraft, travelClass: cabinClass || 'Economy',
        departureAirport: origin, departureAirportName: (originAirport && originAirport.name) || origin,
        departureTime: minutesToClock(depMinutes),
        arrivalAirport: destination, arrivalAirportName: (destAirport && destAirport.name) || destination,
        arrivalTime: minutesToClock(arrMinutes) + (extraDays > 0 ? ` (+${extraDays})` : ''),
        durationMinutes, duration: `${hours}h ${mins}m`, legroom, extensions: [], layoverAfter: null
      }];
    } else {
      const leg1Minutes = Math.round(baseDuration * randRange(rng, 0.35, 0.45));
      const leg2Minutes = baseDuration - leg1Minutes;
      const leg1ArrMinutes = depMinutes + leg1Minutes;
      const leg2DepMinutes = leg1ArrMinutes + layoverMinutes;
      const leg2ArrMinutes = leg2DepMinutes + leg2Minutes;
      const leg2ExtraDays = daysElapsed(leg2DepMinutes, leg2Minutes) - daysElapsed(depMinutes, 0);
      flightSegments = [
        {
          airline: carrier.name, flightNumber, aircraft, travelClass: cabinClass || 'Economy',
          departureAirport: origin, departureAirportName: (originAirport && originAirport.name) || origin,
          departureTime: minutesToClock(depMinutes),
          arrivalAirport: stopCode, arrivalAirportName: stopCityName,
          arrivalTime: minutesToClock(leg1ArrMinutes),
          durationMinutes: leg1Minutes, duration: `${Math.floor(leg1Minutes / 60)}h ${leg1Minutes % 60}m`,
          legroom, extensions: [],
          layoverAfter: { airport: stopCode, airportName: stopCityName, durationMinutes: layoverMinutes, duration: `${Math.floor(layoverMinutes / 60)}h ${layoverMinutes % 60}m`, overnight: false }
        },
        {
          airline: carrier.name, flightNumber: flightNumberFor(rng, carrier.slug), aircraft: pick(rng, MOCK_AIRCRAFT), travelClass: cabinClass || 'Economy',
          departureAirport: stopCode, departureAirportName: stopCityName,
          departureTime: minutesToClock(leg2DepMinutes),
          arrivalAirport: destination, arrivalAirportName: (destAirport && destAirport.name) || destination,
          arrivalTime: minutesToClock(leg2ArrMinutes) + (leg2ExtraDays > 0 ? ` (+${leg2ExtraDays})` : ''),
          durationMinutes: leg2Minutes, duration: `${Math.floor(leg2Minutes / 60)}h ${leg2Minutes % 60}m`,
          legroom: `${Math.round(randRange(rng, 71, 86))} cm`, extensions: [], layoverAfter: null
        }
      ];
    }

    // Rough emissions estimate (no real data in mock mode): ~90kg CO2e per
    // flight-hour as a ballpark, with a plausible ±15% spread vs. "typical".
    const thisFlightKg = Math.round((durationMinutes / 60) * randRange(rng, 75, 105));
    const typicalKg = Math.round(thisFlightKg / randRange(rng, 0.9, 1.1));

    return {
      id: `mock-${origin}-${destination}-${i}`,
      airline: carrier.name,
      slug: carrier.slug,
      flightNumber,
      departureTime: minutesToClock(depMinutes),
      arrivalTime: minutesToClock(arrMinutes) + (extraDays > 0 ? ` (+${extraDays})` : ''),
      durationMinutes,
      duration: `${hours}h ${mins}m`,
      stops: isNonstop ? 0 : 1,
      stopCity,
      price,
      currency: 'INR',
      cabinClass: cabinClass || 'ECONOMY',
      departureDate: date || null,
      segments: flightSegments,
      carbonEmissions: { thisFlightKg, typicalKg, differencePercent: Math.round(((thisFlightKg - typicalKg) / typicalKg) * 100) }
    };
  });

  // Flag the 2 cheapest, nonstop-preferring flights as "best" — same convention
  // used for live Amadeus results and the old static demo data.
  const sorted = [...flights].sort((a, b) => (a.stops - b.stops) || (a.price - b.price));
  const bestIds = new Set(sorted.slice(0, Math.min(2, sorted.length)).map((f) => f.id));
  return flights.map((f) => ({ ...f, best: bestIds.has(f.id) }));
}

module.exports = { generateMockFlights, classifyRoute };
