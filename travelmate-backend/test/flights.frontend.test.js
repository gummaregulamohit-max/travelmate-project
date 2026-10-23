// TravelMate.html's flight filters, sorting and price note — the
// page's real functions, run in a sandbox on flights mapped from the
// hand-built BLR -> AMS fixture (test/fixtures — see its _note).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');
const { mapGoogleFlightsResponse } = require(path.join(ROOT, 'src/utils/transformSerpApiFlights'));
const FIXTURE = require('./fixtures/serpapi-blr-ams-2026-10-22.json');

// The source of one top-level declaration, matched up to its closing brace.
function declaration(startPattern) {
  const start = HTML.search(startPattern);
  assert.ok(start >= 0, `not found in TravelMate.html: ${startPattern}`);
  let open = HTML.indexOf('{', start);
  if (/^(async\s+)?function\b/.test(HTML.slice(start, start + 20))) {
    // The body starts at the "{" after the parameter list
    const body = /\)\s*\{/g;
    body.lastIndex = start;
    const m = body.exec(HTML);
    open = m.index + m[0].length - 1;
  }
  let depth = 0;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, HTML[i + 1] === ';' ? i + 2 : i + 1);
  }
  throw new Error(`unterminated: ${startPattern}`);
}

function load() {
  const context = vm.createContext({});
  vm.runInContext([
    declaration(/function timeBucket\(/),
    declaration(/function matchesFlightFilters\(/),
    declaration(/const FLIGHT_AIRLINE_FILTER_NAMES = \{/),
    declaration(/function flightHasAirline\(/),
    declaration(/function compareFlightsByPrice\(/),
    declaration(/function flightPriceNote\(/),
    'this.api = { matchesFlightFilters, flightHasAirline, compareFlightsByPrice, flightPriceNote };'
  ].join('\n'), context);
  return context.api;
}

const FLIGHTS = mapGoogleFlightsResponse(JSON.parse(JSON.stringify(FIXTURE))).results;
const NO_FILTERS = { maxPrice: 150000, maxDurationHrs: 30, stopVals: [], airlineVals: [], depVals: [], arrVals: [], bagVals: [], avoidVals: [], lowerEmissionsOnly: false };
const filtered = (api, overrides) => FLIGHTS.filter((f) => api.matchesFlightFilters(f, { ...NO_FILTERS, ...overrides }));
const names = (list) => list.map((f) => f.airline).sort();

test('cheapest first is by actual fare, with ties going to the shorter journey', () => {
  const api = load();
  const sorted = [...FLIGHTS].sort(api.compareFlightsByPrice);
  assert.deepEqual(sorted.map((f) => f.price), [27980, 29134, 32554, 42238]);
  const tie = [{ price: 100, durationMinutes: 900 }, { price: 100, durationMinutes: 600 }].sort(api.compareFlightsByPrice);
  assert.deepEqual(tie.map((f) => f.durationMinutes), [600, 900]);
});

test('sorting never ranks a "preferred" airline above a cheaper fare', () => {
  // The old withAirlinePriority() did exactly that whenever an airline box was ticked
  assert.doesNotMatch(HTML, /withAirlinePriority/);
  assert.match(HTML, /if \(flightSortKey === 'price'\) comparator = compareFlightsByPrice;/);
  assert.match(HTML, /const best = filtered\.filter\(f => f\.best\)\.sort\(compareFlightsByPrice\);/);
});

test('airline boxes keep only itineraries flown by a ticked airline', () => {
  const api = load();
  assert.deepEqual(names(filtered(api, { airlineVals: ['etihad'] })), ['Etihad']);
  assert.deepEqual(names(filtered(api, { airlineVals: ['emirates', 'indigo'] })), ['Emirates', 'IndiGo']);
  // Any leg counts: the Air India + KLM itinerary is kept for either airline
  assert.deepEqual(names(filtered(api, { airlineVals: ['klm'] })), ['Air India, KLM']);
  assert.deepEqual(names(filtered(api, { airlineVals: ['air-india'] })), ['Air India, KLM']);
  // A ticked airline with no flights leaves nothing — no stand-ins
  assert.deepEqual(filtered(api, { airlineVals: ['spicejet'] }), []);
});

test('airline names match exactly: Air India is not Air India Express', () => {
  const api = load();
  assert.equal(api.flightHasAirline({ airlines: ['Air India Express'] }, ['air-india']), false);
  assert.equal(api.flightHasAirline({ airlines: ['Air India Express'] }, ['air-india-express']), true);
  assert.equal(api.flightHasAirline({ airlines: ['Qatar Airways'] }, ['qatar']), true);
  assert.equal(api.flightHasAirline({ airlines: ['Akasa Air'] }, ['akasa']), true);
  // Older payloads without `airlines` fall back to the "A, B" name
  assert.equal(api.flightHasAirline({ airline: 'Air India, KLM' }, ['klm']), true);
});

test('price, stops and connection filters apply to the real results', () => {
  const api = load();
  assert.deepEqual(names(filtered(api, { maxPrice: 30000 })), ['Air India, KLM', 'IndiGo']);
  assert.deepEqual(filtered(api, { stopVals: ['nonstop'] }), []);
  assert.equal(filtered(api, { stopVals: ['1stop'] }).length, 4);
  assert.deepEqual(names(filtered(api, { avoidVals: ['avoid-dxb'] })), ['Air India, KLM', 'Etihad', 'IndiGo']);
});

test('departure / arrival time filters read the local clock time, including next-day arrivals', () => {
  const api = load();
  // IndiGo leaves 22:10 and lands 09:05 (+1); Etihad leaves 04:15
  assert.deepEqual(names(filtered(api, { arrVals: ['arr-morning'] })), ['Air India, KLM', 'IndiGo']);
  assert.deepEqual(names(filtered(api, { depVals: ['dep-morning'] })), ['Emirates']);
});

test('the price note says what the fare covers', () => {
  const api = load();
  assert.equal(api.flightPriceNote({ adults: 1, tripType: 'one_way' }), '1 adult, one way');
  assert.equal(api.flightPriceNote({}), '1 adult, one way');
  assert.equal(api.flightPriceNote({ adults: 2, children: 1, tripType: 'round_trip' }), 'total for 3 travellers, round trip');
  assert.doesNotMatch(HTML, /per traveler, one way/);
});

// Book Now (booking options and the airline's price) is covered in flights.booking.test.js.
