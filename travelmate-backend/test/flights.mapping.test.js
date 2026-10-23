// utils/transformSerpApiFlights against a hand-built SerpApi-shaped BLR -> AMS
// response (test/fixtures — see its _note). Pure mapping: no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { mapGoogleFlightsResponse, transformGoogleFlightsResponse } = require(path.join(ROOT, 'src/utils/transformSerpApiFlights'));
const FIXTURE = require('./fixtures/serpapi-blr-ams-2026-10-22.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const mapped = () => mapGoogleFlightsResponse(clone(FIXTURE));
const byToken = (results, token) => results.find((f) => f.id === token);

test('every priced, distinct itinerary is listed — nothing invented, nothing left over', () => {
  const { results } = mapped();
  assert.deepEqual(results.map((f) => f.id).sort(), [
    'fixture-token-ai-klm', 'fixture-token-emirates', 'fixture-token-etihad', 'fixture-token-indigo'
  ]);
});

test('an itinerary keeps its real airline, flight numbers, airports, times, stops and price', () => {
  const f = byToken(mapped().results, 'fixture-token-etihad');
  assert.equal(f.airline, 'Etihad');
  assert.deepEqual(f.airlines, ['Etihad']);
  assert.equal(f.slug, 'etihad');
  assert.deepEqual(f.flightNumbers, ['EY-217', 'EY-77']);
  assert.deepEqual([f.origin, f.destination], ['BLR', 'AMS']);
  assert.deepEqual([f.departureDate, f.departureTime, f.arrivalDate, f.arrivalTime], ['2026-10-22', '04:15', '2026-10-22', '15:20']);
  assert.deepEqual([f.stops, f.stopCity], [1, 'Zayed International Airport (AUH)']);
  assert.deepEqual([f.price, f.currency, f.cabinClass, f.best], [32554, 'INR', 'ECONOMY', true]);
});

test('journey time is SerpApi\'s total_duration, not local clock times subtracted across time zones', () => {
  const f = byToken(mapped().results, 'fixture-token-etihad');
  // 04:15 IST -> 15:20 CEST is 11h05m on the clocks but 14h35m of travel
  assert.deepEqual([f.durationMinutes, f.duration], [875, '14h 35m']);
  assert.deepEqual(f.segments.map((s) => s.durationMinutes), [280, 465]);
  assert.deepEqual(f.segments[0].layoverAfter, { airport: 'AUH', airportName: 'Zayed International Airport', durationMinutes: 130, duration: '2h 10m', overnight: false });
});

test('an overnight connection marks the later day on the arrival and on each segment', () => {
  const f = byToken(mapped().results, 'fixture-token-indigo');
  assert.equal(f.arrivalTime, '09:05 (+1)');
  assert.equal(f.arrivalDate, '2026-10-23');
  assert.deepEqual(f.segments.map((s) => [s.departureTime, s.arrivalTime]), [['22:10', '23:55'], ['02:40 (+1)', '09:05 (+1)']]);
  assert.deepEqual(f.segments.map((s) => [s.departureDate, s.arrivalDate]), [['2026-10-22', '2026-10-22'], ['2026-10-23', '2026-10-23']]);
  assert.equal(f.segments[0].layoverAfter.overnight, true);
});

test('segments listed out of order are put back in travel order', () => {
  const f = byToken(mapped().results, 'fixture-token-ai-klm');
  assert.deepEqual(f.segments.map((s) => `${s.departureAirport}-${s.arrivalAirport}`), ['BLR-DEL', 'DEL-AMS']);
  assert.deepEqual([f.origin, f.destination, f.departureTime, f.arrivalTime], ['BLR', 'AMS', '20:00', '08:40 (+1)']);
  assert.equal(f.flightNumber, 'AI-2803', 'the first flight flown, not the first one listed');
});

test('a two-airline itinerary names every airline, in travel order', () => {
  const f = byToken(mapped().results, 'fixture-token-ai-klm');
  assert.equal(f.airline, 'Air India, KLM');
  assert.deepEqual(f.airlines, ['Air India', 'KLM']);
  assert.equal(f.slug, 'air-india');
  assert.deepEqual(f.flightNumbers, ['AI-2803', 'KL-872']);
});

test('an itinerary without a fare is not listed, but is counted', () => {
  const out = mapped();
  assert.equal(byToken(out.results, 'fixture-token-qatar-no-price'), undefined);
  assert.equal(out.unpricedCount, 1);
  assert.ok(out.results.every((f) => typeof f.price === 'number' && f.price > 0));
});

test('the same itinerary listed twice keeps the cheaper fare and its "best" flag', () => {
  const indigo = mapped().results.filter((f) => f.flightNumbers.join() === '6E-6123,6E-23');
  assert.equal(indigo.length, 1);
  assert.deepEqual([indigo[0].price, indigo[0].best], [29134, true]);
});

test('currency comes from the search SerpApi ran, not an assumption', () => {
  const usd = clone(FIXTURE);
  usd.search_parameters.currency = 'USD';
  const out = mapGoogleFlightsResponse(usd);
  assert.equal(out.currency, 'USD');
  assert.ok(out.results.every((f) => f.currency === 'USD'));
});

test('a fare sent as text ("₹29,134") is read as the number it is', () => {
  const text = clone(FIXTURE);
  text.best_flights[0].price = '₹29,134';
  assert.equal(byToken(mapGoogleFlightsResponse(text).results, 'fixture-token-indigo').price, 29134);
});

test('Google\'s price insights and the Google Flights link are passed through as given', () => {
  const out = mapped();
  assert.deepEqual(out.priceInsights, { lowestPrice: 27980, priceLevel: 'typical', typicalPriceRange: [26000, 41000] });
  assert.equal(out.googleFlightsUrl, FIXTURE.search_metadata.google_flights_url);
  assert.ok(out.results.every((f) => f.bookingUrl === FIXTURE.search_metadata.google_flights_url));
});

test('no price insights or link in the response means none are made up', () => {
  const bare = clone(FIXTURE);
  delete bare.price_insights;
  delete bare.search_metadata.google_flights_url;
  const out = mapGoogleFlightsResponse(bare);
  assert.equal(out.priceInsights, null);
  assert.equal(out.googleFlightsUrl, null);
  assert.ok(out.results.every((f) => f.bookingUrl === null));
});

test('empty, missing or malformed responses map to no flights, without throwing', () => {
  for (const body of [{}, null, undefined, { best_flights: null, other_flights: 'x' }, { best_flights: [null, { flights: [] }] }]) {
    const out = mapGoogleFlightsResponse(body);
    assert.deepEqual(out.results, []);
    assert.equal(out.unpricedCount, 0);
  }
});

test('transformGoogleFlightsResponse still returns just the list', () => {
  assert.deepEqual(transformGoogleFlightsResponse(clone(FIXTURE)), mapped().results);
});
