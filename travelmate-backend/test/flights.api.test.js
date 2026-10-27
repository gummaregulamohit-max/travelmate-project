// GET /api/flights/search, offline: axios.get is stubbed with SerpApi-shaped
// payloads, so no SerpApi search is spent and no real key is used.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');

const ROOT = path.join(__dirname, '..');
// The fixed travel dates in these tests stay valid: "today" is pinned for
// travel-date checks (see TRAVELMATE_TODAY in src/utils/requestNormalizers.js).
process.env.TRAVELMATE_TODAY = '2026-10-20';
process.env.NODE_ENV = 'test'; // TRAVELMATE_TODAY only applies in the test environment
const FAKE_KEY = 'fake-serpapi-key-for-flight-tests';
process.env.SERPAPI_KEY = FAKE_KEY;

const realGet = axios.get;
let calls;
let respond;
beforeEach(() => {
  calls = [];
  axios.get = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
});
afterEach(() => { axios.get = realGet; });

// One itinerary as SerpApi's google_flights engine returns it (values from a
// real BLR -> DEL response).
const ONE_FLIGHT = {
  best_flights: [{
    flights: [{
      departure_airport: { name: 'Kempegowda International Airport', id: 'BLR', time: '2026-11-20 06:10' },
      arrival_airport: { name: 'Indira Gandhi International Airport', id: 'DEL', time: '2026-11-20 09:00' },
      duration: 170, airline: 'Akasa Air', flight_number: 'QP 1823', travel_class: 'Economy'
    }],
    total_duration: 170, price: 11218, type: 'One way'
  }],
  other_flights: []
};

// Hand-built BLR -> AMS response (see the fixture's _note).
const FIXTURE = require('./fixtures/serpapi-blr-ams-2026-10-22.json');

// SerpApi's answer when Google Flights has nothing on the route that day (from
// a real BLR -> RQY search): HTTP 200, an `error` string, state "Fully empty".
const FULLY_EMPTY = {
  search_metadata: { id: 'x', status: 'Success' },
  search_information: { flights_results_state: 'Fully empty' },
  error: "Google Flights hasn't returned any results for this query."
};

async function search(query) {
  const app = express();
  app.use('/api/flights', require(path.join(ROOT, 'src/routes/flights.routes')));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/flights/search${query}`);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  } finally {
    srv.close();
  }
}

test('a SerpApi answer is returned as live flights', async () => {
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  const { status, body } = await search('?origin=BLR&destination=DEL&departureDate=2026-11-20');
  assert.equal(status, 200);
  assert.equal(body.meta.source, 'live');
  assert.equal(body.meta.cached, false);
  assert.equal(body.results.length, 1);
  const [f] = body.results;
  assert.deepEqual([f.airline, f.flightNumber, f.departureTime, f.arrivalTime, f.duration, f.stops, f.price, f.currency],
    ['Akasa Air', 'QP-1823', '06:10', '09:00', '2h 50m', 0, 11218, 'INR']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.params.departure_id, 'BLR');
  assert.equal(calls[0].opts.params.arrival_id, 'DEL');
});

test('"no flights on this route" stays a live, empty answer — never invented flights', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: FULLY_EMPTY });
  const { status, body } = await search('?origin=BLR&destination=RQY&departureDate=2026-11-21');
  assert.equal(status, 200);
  assert.equal(body.meta.source, 'live');
  assert.equal(body.meta.count, 0);
  assert.deepEqual(body.results, []);
});

test('a SerpApi failure is a 502 with no flights — never generated stand-ins', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' } });
  const { status, body } = await search('?origin=BLR&destination=DEL&departureDate=2026-11-22');
  assert.equal(status, 502);
  assert.equal(body.error.reason, 'provider_error');
  assert.match(body.error.message, /could not be retrieved/);
  // SerpApi's own message (and its links) stay in the server log
  assert.doesNotMatch(body.error.message, /Invalid API key|serpapi\.com/);
  assert.deepEqual(body.results, []);
  assert.equal(body.meta.source, 'unavailable');
  assert.equal(body.meta.count, 0);
});

test('a network failure or timeout is also a 502 with no flights', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => { const e = new Error('timeout of 20000ms exceeded'); e.code = 'ECONNABORTED'; throw e; };
  const { status, body } = await search('?origin=BLR&destination=AMS&departureDate=2026-11-25');
  assert.equal(status, 502);
  assert.deepEqual(body.results, []);
  assert.equal(body.meta.source, 'unavailable');
  assert.doesNotMatch(body.error.message, /timeout of|ECONNABORTED/);
});

test('the provider\'s error text is logged for debugging, though the browser never sees it', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: { error: 'Unsupported departure_id parameter.' } });
  const { body } = await search('?origin=BLR&destination=HBX&departureDate=2026-11-27');
  assert.equal(body.error.message, 'Live flight prices could not be retrieved right now. No flights are shown rather than guessed ones — please try again.');
  assert.ok(logged.some((l) => l.includes('Unsupported departure_id parameter.')), 'provider message logged');
});

test('a failed search is not cached: the next try asks SerpApi again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: { error: 'Something went wrong' } });
  await search('?origin=BLR&destination=GOI&departureDate=2026-11-26');
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  const second = await search('?origin=BLR&destination=GOI&departureDate=2026-11-26');
  assert.equal(second.status, 200);
  assert.equal(second.body.meta.source, 'live');
  assert.equal(calls.length, 2);
});

test('without SERPAPI_KEY the answer is a 503 with no flights, and SerpApi is not called', async (t) => {
  delete process.env.SERPAPI_KEY;
  t.after(() => { process.env.SERPAPI_KEY = FAKE_KEY; });
  const { status, body } = await search('?origin=BLR&destination=AMS&departureDate=2026-10-22');
  assert.equal(status, 503);
  assert.equal(body.error.reason, 'not_configured');
  assert.deepEqual(body.results, []);
  assert.equal(body.meta.source, 'unavailable');
  assert.equal(calls.length, 0);
});

test('the reference search is sent as searched: India point of sale, INR, one way, 1 adult, economy', async () => {
  respond = () => ({ status: 200, data: FIXTURE });
  await search('?origin=BLR&destination=AMS&date=2026-10-22&cabinClass=ECONOMY&adults=1&children=0&infants=0');
  const { params } = calls[0].opts;
  assert.deepEqual(
    { departure_id: params.departure_id, arrival_id: params.arrival_id, outbound_date: params.outbound_date, type: params.type,
      currency: params.currency, gl: params.gl, hl: params.hl, adults: params.adults, travel_class: params.travel_class },
    { departure_id: 'BLR', arrival_id: 'AMS', outbound_date: '2026-10-22', type: 2, currency: 'INR', gl: 'in', hl: 'en', adults: 1, travel_class: 1 });
  assert.equal(params.return_date, undefined);
  assert.equal(params.children, undefined);
  assert.equal(params.infants_on_lap, undefined);
  assert.equal(params.deep_search, undefined, 'deep search is opt-in');
});

test('passengers and cabin reach SerpApi', async () => {
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  await search('?origin=BLR&destination=AMS&date=2026-10-23&cabinClass=PREMIUM-ECONOMY&adults=2&children=1&infants=1');
  await search('?origin=BLR&destination=AMS&date=2026-10-23&cabinClass=BUSINESS');
  await search('?origin=BLR&destination=AMS&date=2026-10-23&cabinClass=first');
  assert.deepEqual(calls.map((c) => c.opts.params.travel_class), [2, 3, 4]);
  const p = calls[0].opts.params;
  assert.deepEqual([p.adults, p.children, p.infants_on_lap], [2, 1, 1]);
});

test('SERPAPI_DEEP_SEARCH=true turns on SerpApi deep search', async (t) => {
  process.env.SERPAPI_DEEP_SEARCH = 'true';
  t.after(() => { delete process.env.SERPAPI_DEEP_SEARCH; });
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  await search('?origin=BLR&destination=AMS&date=2026-10-24');
  assert.equal(calls[0].opts.params.deep_search, true);
});

test('a different passenger count is a different search, not a cache hit', async () => {
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  await search('?origin=BLR&destination=CCU&departureDate=2026-11-27&adults=1');
  const two = await search('?origin=BLR&destination=CCU&departureDate=2026-11-27&adults=2');
  assert.equal(two.body.meta.cached, false);
  assert.equal(calls.length, 2);
});

test('a live answer says what was searched, when it was fetched, and what the price covers', async () => {
  respond = () => ({ status: 200, data: FIXTURE });
  const before = Date.now();
  // A date no other test searches, so this is a fresh answer, not a cache hit
  const { body } = await search('?origin=BLR&destination=AMS&date=2026-10-30&adults=1');
  const m = body.meta;
  assert.equal(m.cached, false);
  assert.deepEqual(
    [m.source, m.origin, m.destination, m.departureDate, m.returnDate, m.tripType, m.cabinClass, m.adults, m.children, m.infants, m.currency, m.priceBasis],
    ['live', 'BLR', 'AMS', '2026-10-30', null, 'one_way', 'ECONOMY', 1, 0, 0, 'INR', 'total_for_all_passengers']);
  assert.ok(Date.parse(m.retrievedAt) >= before - 1000, 'retrievedAt is a fresh ISO time');
  assert.equal(m.count, 4);
  assert.equal(m.unpricedCount, 1);
  assert.deepEqual(m.priceInsights, { lowestPrice: 27980, priceLevel: 'typical', typicalPriceRange: [26000, 41000] });
  assert.equal(m.googleFlightsUrl, FIXTURE.search_metadata.google_flights_url);
});

test('a cached answer keeps the time it was first fetched', async () => {
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  const first = await search('?origin=BLR&destination=PNQ&departureDate=2026-11-28');
  const second = await search('?origin=BLR&destination=PNQ&departureDate=2026-11-28');
  assert.equal(second.body.meta.cached, true);
  assert.equal(second.body.meta.retrievedAt, first.body.meta.retrievedAt);
});

test('the SerpApi key never appears in an error response or the server log', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  respond = () => ({ status: 200, data: { error: 'Invalid API key.' } });
  const { text } = await search('?origin=BLR&destination=IXC&departureDate=2026-11-29');
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(logged.length > 0);
  assert.ok(logged.every((l) => !l.includes(FAKE_KEY)));
});

test('a repeat search is served from cache and says so', async () => {
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  const first = await search('?origin=BLR&destination=BOM&departureDate=2026-11-23');
  const second = await search('?origin=BLR&destination=BOM&departureDate=2026-11-23');
  assert.equal(first.body.meta.cached, false);
  assert.equal(second.body.meta.cached, true);
  assert.equal(second.body.meta.source, 'live');
  assert.deepEqual(second.body.results, first.body.results);
  assert.equal(calls.length, 1, 'the second search made no SerpApi request');
});

test('the SerpApi key never appears in a flight response', async () => {
  respond = () => ({ status: 200, data: ONE_FLIGHT });
  const { text } = await search('?origin=BLR&destination=MAA&departureDate=2026-11-24');
  assert.ok(!text.includes(FAKE_KEY));
});
