// GET /api/flights/search, offline: axios.get is stubbed with SerpApi-shaped
// payloads, so no SerpApi search is spent and no real key is used.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');

const ROOT = path.join(__dirname, '..');
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

test('a real SerpApi failure still falls back to clearly-labelled mock flights', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' } });
  const { status, body } = await search('?origin=BLR&destination=DEL&departureDate=2026-11-22');
  assert.equal(status, 200);
  assert.equal(body.meta.source, 'mock');
  assert.ok(body.results.length > 0);
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
