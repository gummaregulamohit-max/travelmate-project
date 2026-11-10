// Unified location directory behind the From / To autocomplete.
//
// Cities, towns and villages are the entities. Each one explicitly links the
// infrastructure points that serve it:
//
//   { name, type, district, state, country,
//     points: {
//       airports:  [{ code, name }],   // flights
//       stations:  [{ code, name }],   // trains
//       busPoints: [{ name }]          // buses — boarding / dropping points
//     } }
//
// e.g. Bengaluru -> airports [BLR Kempegowda International Airport],
// stations [SBC, YPR, SMVB, ...], busPoints [Majestic, Silk Board, ...].
// A place in India always has bus points (hand-listed for the big cities in
// data/busPoints.js, otherwise named after the place); places abroad only
// have airports, so an international trip is flights only.
//
// Sources:
//   - data/places.tsv.gz — ~1.5 lakh Indian cities and villages (India Post
//     office directory + GeoNames), the same directory the frontend bundles.
//     Format: line 0 is the tab-separated state list; a "#<stateIdx> <district>
//     <lat*100> <lng*100>" line opens a district; every other line is
//     "<name> <dLat> <dLng> <flags>" — flags "C" = city (20,000+ people or a
//     district HQ), "*" = name shared with a place in another district.
//   - stations.service — every Indian Railways station with its city / state.
//   - data/airports.json — airports with their city / country.
//
// The directory only tells cities and villages apart, so a "Town" here is a
// place that isn't flagged as a city but has its own railway station or airport.
//
// Built once on first use (or warmUp()) and kept in memory.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadStations } = require('./stations.service');
const { CITY_BUS_POINTS, busPointsFor } = require('../data/busPoints');

const PLACES_PATH = path.join(__dirname, '..', 'data', 'places.tsv.gz');

// Older / popular spellings lead to the current name.
const ALIASES = {
  shimoga: 'shivamogga', bangalore: 'bengaluru', mysore: 'mysuru', bombay: 'mumbai', madras: 'chennai',
  calcutta: 'kolkata', belgaum: 'belagavi', hubli: 'hubballi', gulbarga: 'kalaburagi', bellary: 'ballari',
  bijapur: 'vijayapura', tumkur: 'tumakuru', trivandrum: 'thiruvananthapuram', cochin: 'kochi',
  calicut: 'kozhikode', pondicherry: 'puducherry', vizag: 'visakhapatnam', baroda: 'vadodara',
  benares: 'varanasi', banaras: 'varanasi', allahabad: 'prayagraj', gurgaon: 'gurugram', trichy: 'tiruchirappalli',
  poona: 'pune', cuddapah: 'kadapa', mangaluru: 'mangalore', tuticorin: 'thoothukudi', trichur: 'thrissur',
  quilon: 'kollam', palghat: 'palakkad', simla: 'shimla', chikmagalur: 'chikkamagaluru', secunderabad: 'hyderabad'
};

const TYPE_RANK = { City: 0, Town: 1, Village: 2 };

// The main terminals of the big cities, in the order they are listed. The
// station directory files some of them under a neighbourhood of their own
// (Yelahanka, Hadapsar, New Delhi), so they are tied to their city here.
const MAJOR_CITY_STATIONS = {
  bengaluru: ['SBC', 'YPR', 'SMVB', 'YNK'],
  hyderabad: ['SC', 'HYB', 'KCG', 'CHZ'],
  delhi: ['NDLS', 'DLI', 'NZM', 'ANVT'],
  mumbai: ['CSMT', 'MMCT', 'BDTS', 'LTT'],
  kolkata: ['HWH', 'SDAH', 'KOAA', 'SHM'],
  chennai: ['MAS', 'MS'],
  pune: ['PUNE', 'HDP']
};
const MAJOR_STATION_CITY = new Map(
  Object.entries(MAJOR_CITY_STATIONS).flatMap(([city, codes]) => codes.map((code) => [code, city])));

const NOT_A_PLACE = /\d|\.|\b[A-Z]{2,}\b/;
const PAREN = /\s*\(.*\)\s*/;
const NOT_A_LOCALITY = /\b(airport|railway|station|bus stand|office|institute|university|college|campus|hospital|colony|nagar road)\b/i;

// State names the station directory spells differently from the place directory.
const STATE_NAMES = { 'Delhi NCT': 'Delhi', Orissa: 'Odisha', Pondicherry: 'Puducherry', Uttaranchal: 'Uttarakhand' };

let index = null;

// "Rampur (Bareilly)" -> "rampur"
const baseName = (name) => name.replace(/\s*\(.*\)\s*/, '').trim().toLowerCase();

function buildIndex() {
  const places = [];
  const byBase = new Map(); // lower-case base name -> [place]
  const byCode = new Map(); // lower-case station / airport code -> place
  const byCodeExtra = new Map(); // second place for a code shared by an airport and a station
  const pointIndex = []; // { lc, place, match } — every airport, station and listed bus point by name

  const addPlace = (place) => {
    place.base = baseName(place.name);
    place.points = { airports: [], stations: [], busPoints: [] };
    places.push(place);
    if (!byBase.has(place.base)) byBase.set(place.base, []);
    byBase.get(place.base).push(place);
    return place;
  };

  // ---- cities and villages ----
  const lines = zlib.gunzipSync(fs.readFileSync(PLACES_PATH)).toString('utf8').split('\n');
  const states = lines[0].split('\t');
  const taken = new Set();
  let state = '', district = '';
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    if (!f[0]) continue;
    if (f[0][0] === '#') { state = states[+f[0].slice(1)]; district = f[1]; continue; }
    const flag = f[3] || '';
    // Places that share a name get their district in brackets — the same
    // naming the frontend uses, so a name picked here matches its bus search.
    let name = f[0];
    if (flag.includes('*') || taken.has(name.toLowerCase())) name = `${name} (${district})`;
    const lc = name.toLowerCase();
    if (taken.has(lc)) continue;
    taken.add(lc);
    addPlace({ name, type: flag.includes('C') ? 'City' : 'Village', district, state, country: 'India' });
  }

  // The place a station / airport belongs to: the city of that name when there
  // is one, otherwise the only place of that name (in that state, when known).
  // A name shared by several villages can't be pinned to one of them, so it
  // gets (or reuses) an entry of its own rather than being guessed.
  const extras = new Map(); // "<base>|<state>" -> place created for a station / airport
  const existingPlace = (base, stateName) => {
    let candidates = (byBase.get(base) || []).filter((p) => p.country === 'India');
    if (stateName) {
      const inState = candidates.filter((p) => p.state === stateName);
      if (inState.length) candidates = inState;
    }
    if (!candidates.length) return null;
    const cities = candidates.filter((p) => p.type === 'City');
    const exact = cities.filter((p) => p.name.toLowerCase() === base); // "Rampur" over "Rampur (Saharanpur)"
    if (exact.length === 1) return exact[0];
    if (cities.length === 1) return cities[0];
    if (candidates.length === 1) return candidates[0];
    return undefined; // ambiguous
  };
  const placeFor = (cityName, stateName, typeIfNew) => {
    const base = ALIASES[baseName(cityName)] || baseName(cityName);
    const found = existingPlace(base, stateName);
    if (found) return found;
    const key = `${base}|${stateName || ''}`;
    if (!extras.has(key)) {
      extras.set(key, addPlace({ name: cityName, type: typeIfNew, district: '', state: stateName || '', country: 'India' }));
    }
    return extras.get(key);
  };

  // ---- airports ----
  const abroad = new Map(); // "<city>|<country>" -> place
  for (const ap of require('../data/airports.json')) {
    let place;
    if (ap.country === 'India') {
      place = placeFor(ap.city, '', 'City');
    } else {
      const key = `${ap.city.toLowerCase()}|${ap.country}`;
      if (!abroad.has(key)) {
        abroad.set(key, addPlace({ name: ap.city, type: 'City', district: '', state: '', country: ap.country }));
      }
      place = abroad.get(key);
    }
    place.points.airports.push({ code: ap.code, name: ap.name });
    byCode.set(ap.code.toLowerCase(), place);
    pointIndex.push({ lc: ap.name.toLowerCase(), place, match: { kind: 'airport', code: ap.code, name: ap.name } });
  }

  // ---- railway stations ----
  // A big city's stations are often listed under their own names ("Mumbai
  // Dadar", "Delhi Shahdara", "Bangalore East") or a joint one ("Hyderabad /
  // Secunderabad"). Those belong to the city: a station whose place name isn't
  // a locality of its own is attached to the airport city its name starts with.
  const metroFor = (cityName, stateName) => {
    const words = baseName(cityName).split(/\s+/);
    for (let k = words.length - 1; k >= 1; k--) {
      const head = words.slice(0, k).join(' ');
      const metros = (byBase.get(ALIASES[head] || head) || []).filter((p) =>
        p.country === 'India' && p.type === 'City' && p.points.airports.length && (!stateName || !p.state || p.state === stateName));
      if (metros.length === 1) return metros[0];
    }
    return null;
  };
  for (const st of loadStations()) {
    const cityName = (st.city || st.name).split('/')[0].trim();
    const stateName = STATE_NAMES[st.state] || st.state;
    const base = ALIASES[baseName(cityName)] || baseName(cityName);
    const place = (MAJOR_STATION_CITY.has(st.code) && existingPlace(MAJOR_STATION_CITY.get(st.code), '')) ||
      (existingPlace(base, stateName) === null && metroFor(cityName, stateName)) || placeFor(cityName, stateName, 'Town');
    place.points.stations.push({ code: st.code, name: st.name });
    pointIndex.push({ lc: st.name.toLowerCase(), place, match: { kind: 'station', code: st.code, name: st.name } });
    // A code used by both an airport and a station (e.g. "GOA") finds both
    if (!byCode.has(st.code.toLowerCase())) byCode.set(st.code.toLowerCase(), place);
    else if (byCode.get(st.code.toLowerCase()) !== place) byCodeExtra.set(st.code.toLowerCase(), place);
  }

  // A big city's main terminals lead its station list
  for (const [city, codes] of Object.entries(MAJOR_CITY_STATIONS)) {
    const place = existingPlace(city, '');
    if (!place) continue;
    const rank = (st) => (codes.includes(st.code) ? codes.indexOf(st.code) : codes.length);
    place.points.stations.sort((a, b) => rank(a) - rank(b));
  }

  // ---- bus boarding / dropping points ----
  // Hand-listed for the big cities; every other Indian place gets points
  // named after itself when it is returned (see placePoints).
  for (const [city, names] of Object.entries(CITY_BUS_POINTS)) {
    const place = existingPlace(city, '');
    if (!place) continue;
    place.points.busPoints = names.map((name) => ({ name }));
    for (const name of names) pointIndex.push({ lc: name.toLowerCase(), place, match: { kind: 'busPoint', name } });
  }

  for (const p of places) {
    if (p.type === 'Village' && (p.points.stations.length || p.points.airports.length)) p.type = 'Town';
    // The village list comes from the post-office directory, which also holds
    // entries that aren't places ("N.C.L. Pune", "Sector46", "IBC Hyderabad").
    // A bus-only entry whose name has digits, dots or an all-capitals word, or
    // names a facility rather than a locality, is left out of the suggestions.
    const plain = p.name.replace(PAREN, '');
    p.hidden = p.type === 'Village' && (NOT_A_PLACE.test(plain) || NOT_A_LOCALITY.test(plain));
    p.modes = [];
    if (p.points.airports.length) p.modes.push('flights');
    if (p.points.stations.length) p.modes.push('trains');
    if (p.country === 'India') p.modes.push('buses');
  }

  return { places, byBase, byCode, byCodeExtra, pointIndex };
}

function getIndex() {
  if (!index) index = buildIndex();
  return index;
}

// How many station / airport codes a suggestion lists before "+N more".
const LINK_CODES = 3;

// The infrastructure points of a place. `flightsOnly` (an international
// trip) keeps the airports and drops what can't be used across a border.
function placePoints(p, flightsOnly) {
  const inIndia = p.country === 'India';
  const listed = p.points.busPoints.length > 0;
  return {
    airports: p.points.airports,
    stations: flightsOnly ? [] : p.points.stations,
    busPoints: flightsOnly || !inIndia ? []
      : listed ? p.points.busPoints : busPointsFor(p.name, p.type).map((name) => ({ name }))
  };
}

// One entry per transport mode, always flights, trains, buses: whether the
// mode reaches the place, and through which airports / stations.
function transportLinks(points) {
  const link = (mode, label, list, coded) => ({
    mode,
    label,
    available: list.length > 0,
    codes: coded ? list.slice(0, LINK_CODES).map((x) => x.code) : [],
    more: coded ? Math.max(0, list.length - LINK_CODES) : 0
  });
  return [
    link('flights', 'Flights', points.airports, true),
    link('trains', 'Trains', points.stations, true),
    link('buses', 'Buses', points.busPoints, false)
  ];
}

/**
 * A place as the API returns it. `match` (optional) says which of its points
 * the search text matched, e.g. { kind: "busPoint", name: "Silk Board" }.
 */
function toResult(p, { flightsOnly = false, match } = {}) {
  // "Rampur (Saharanpur)" is shown as "Rampur" with the district underneath
  const title = p.name.replace(/\s*\(.*\)\s*/, '').trim();
  const region = p.country === 'India' ? p.state : p.country;
  const subtitle = [p.district !== title ? p.district : '', region].filter(Boolean).join(', ');
  const points = placePoints(p, flightsOnly);
  const links = transportLinks(points);
  return {
    name: p.name, // unique name — what a search for this place uses
    title,
    subtitle,
    type: p.type,
    district: p.district,
    state: p.state,
    country: p.country,
    domestic: p.country === 'India',
    modes: links.filter((l) => l.available).map((l) => l.mode),
    points,
    busPointsListed: points.busPoints.length > 0 && p.points.busPoints.length > 0, // false = named after the place
    links,
    ...(match ? { match } : {})
  };
}

// Every place matching `query`, best first, as [place, score, match] triples.
// A place is found by its own name, by a station / airport code, or by the
// name of one of its points ("Silk Board", "Kacheguda", "Kempegowda") — in
// which case `match` says which point.
// Scores: 0 exact name or code, 0.5 exact point name, 1 an older spelling of
// the name ("Bangalore"), 2 prefix of the name or of a point name, 3 word
// prefix in either, 4 (3+ letters) anywhere in the name. Within a score, places with an airport come first, then the
// better-connected ones, then cities, towns, villages.
function rankLocations(query, { country, trip } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const { places, byBase, byCode, byCodeExtra, pointIndex } = getIndex();
  const flightsOnly = trip === 'international';

  const scored = new Map(); // place -> { score, match } (lowest score wins)
  const offer = (p, score, match) => {
    if (country && p.country !== country) return;
    if (flightsOnly && !p.points.airports.length) return; // can't be reached on an international trip
    if (!scored.has(p) || scored.get(p).score > score) scored.set(p, { score, match });
  };

  for (const p of places) {
    if (p.hidden) continue;
    const b = p.base;
    if (b === q) offer(p, 0);
    else if (b.startsWith(q)) offer(p, 2);
    else if (b.includes(q)) {
      if (b.includes(' ' + q) || b.includes('-' + q)) offer(p, 3);
      else if (q.length >= 3) offer(p, 4);
    }
  }
  if (byCode.has(q)) offer(byCode.get(q), 0);
  if (byCodeExtra.has(q)) offer(byCodeExtra.get(q), 0);
  if (q.length >= 4) {
    const alias = Object.keys(ALIASES).find((a) => a.startsWith(q));
    if (alias) {
      const targets = (byBase.get(ALIASES[alias]) || []).filter((p) => p.type === 'City');
      targets.forEach((p) => offer(p, 1));
    }
  }
  if (q.length >= 3) {
    for (const { lc, place, match } of pointIndex) {
      if (flightsOnly && match.kind !== 'airport') continue;
      if (lc === q) offer(place, 0.5, match);
      else if (lc.startsWith(q)) offer(place, 2, match);
      else if (lc.includes(' ' + q)) offer(place, 3, match);
    }
  }

  return [...scored.entries()]
    .sort(([a, sa], [b, sb]) =>
      sa.score - sb.score ||
      (b.points.airports.length > 0) - (a.points.airports.length > 0) ||
      b.modes.length - a.modes.length ||
      TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
      a.base.length - b.base.length ||
      a.name.localeCompare(b.name))
    .map(([p, { score, match }]) => [p, score, match]);
}

/**
 * Ranked search over localities. Options:
 *   country — keep results to one country, e.g. "India"
 *   trip    — "international" keeps only places with an airport and returns
 *             only their airports (flights are the one mode that crosses a border)
 */
function searchLocations(query, { limit = 20, country, trip } = {}) {
  const flightsOnly = trip === 'international';
  return rankLocations(query, { country, trip }).slice(0, limit).map(([p, , match]) => toResult(p, { flightsOnly, match }));
}

/**
 * The single place a piece of From / To text refers to, or null. `exact` is
 * true when the text is the place's name, an older spelling of it, or one of
 * its station / airport codes or point names; otherwise it is only the
 * closest match.
 */
function resolveLocation(text) {
  const ranked = rankLocations(text);
  if (!ranked.length) return null;
  const [place, score, match] = ranked[0];
  return { ...toResult(place, { match }), exact: score <= 1 };
}

const DOMESTIC_MODES = ['flights', 'trains', 'buses'];
const INTERNATIONAL_MODES = ['flights'];

/**
 * Trip type for a From / To pair: "domestic" when both places are in India
 * (flights, trains and buses), "international" as soon as either is abroad
 * (flights only — trains and buses here don't cross borders). `tripType` is
 * null when a side can't be matched to any place.
 */
function determineTripType(fromText, toText) {
  const from = resolveLocation(fromText);
  const to = resolveLocation(toText);
  if (!from || !to) return { tripType: null, modes: [], from, to };
  const tripType = from.domestic && to.domestic ? 'domestic' : 'international';
  if (tripType === 'domestic') return { tripType, modes: DOMESTIC_MODES, from, to };
  // Flights only: drop the stations and bus points of the Indian end
  const [fromPlace, , fromMatch] = rankLocations(fromText)[0];
  const [toPlace, , toMatch] = rankLocations(toText)[0];
  return {
    tripType,
    modes: INTERNATIONAL_MODES,
    from: { ...toResult(fromPlace, { flightsOnly: true, match: fromMatch }), exact: from.exact },
    to: { ...toResult(toPlace, { flightsOnly: true, match: toMatch }), exact: to.exact }
  };
}

function directoryStats() {
  const { places } = getIndex();
  const count = (fn) => places.filter(fn).length;
  return {
    places: places.length,
    hidden: count((p) => p.hidden),
    cities: count((p) => p.type === 'City'),
    towns: count((p) => p.type === 'Town'),
    villages: count((p) => p.type === 'Village'),
    withListedBusPoints: count((p) => p.points.busPoints.length > 0),
    withStations: count((p) => p.points.stations.length > 0),
    withAirports: count((p) => p.points.airports.length > 0)
  };
}

// Builds the index ahead of the first request.
function warmUp() {
  return directoryStats();
}

module.exports = { searchLocations, resolveLocation, determineTripType, directoryStats, warmUp };
