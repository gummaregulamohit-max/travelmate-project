// Book Now's booking options: who sells an itinerary and at what price, so a
// card can show the airline's own fare. Offline: mapping runs on hand-built
// fixtures (test/fixtures — see their _note) and axios.get is stubbed, so no
// SerpApi search is spent.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');

const ROOT = path.join(__dirname, '..');
// The fixed travel dates in these tests stay valid: "today" is pinned for
// travel-date checks (see TRAVELMATE_TODAY in src/utils/requestNormalizers.js).
process.env.TRAVELMATE_TODAY = '2026-10-20';
process.env.NODE_ENV = 'test'; // TRAVELMATE_TODAY only applies in the test environment
const FAKE_KEY = 'fake-serpapi-key-for-booking-tests';
process.env.SERPAPI_KEY = FAKE_KEY;

const { mapBookingOptions } = require(path.join(ROOT, 'src/utils/transformSerpApiFlights'));
const SEARCH = require('./fixtures/serpapi-blr-ams-2026-10-22.json');
const BOOKING = require('./fixtures/serpapi-booking-options-blr-ams.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

// --- mapping -------------------------------------------------------------------

test('the airline\'s own offer is listed first, then agents cheapest first', () => {
  const { options } = mapBookingOptions(clone(BOOKING), ['IndiGo', 'Qatar Airways']);
  assert.deepEqual(options.map((o) => [o.bookWith, o.price, o.isAirline]), [
    ['Qatar Airways', 29134, true],
    ['MakeMyTrip', 27005, false],
    ['Goibibo', 27105, false],
    ['EaseMyTrip', 28505, false]
  ]);
});

test('the airline\'s fare and the cheapest fare are both reported, and are different things', () => {
  const out = mapBookingOptions(clone(BOOKING), ['IndiGo', 'Qatar Airways']);
  assert.deepEqual([out.airlineOption.bookWith, out.airlineOption.price], ['Qatar Airways', 29134]);
  assert.deepEqual([out.cheapestOption.bookWith, out.cheapestOption.price], ['MakeMyTrip', 27005]);
  assert.equal(out.currency, 'INR');
});

test('a seller counts as the airline when SerpApi says so, or when it is one of the itinerary\'s airlines', () => {
  const unflagged = clone(BOOKING);
  delete unflagged.booking_options[0].together.airline;
  assert.equal(mapBookingOptions(unflagged, ['IndiGo', 'Qatar Airways']).airlineOption.bookWith, 'Qatar Airways');
  // Without the flag and without the airline names, nobody is the airline
  assert.equal(mapBookingOptions(unflagged, []).airlineOption, null);
});

test('only Google\'s own redirect is passed on as a booking link', () => {
  const { options } = mapBookingOptions(clone(BOOKING), []);
  const qatar = options.find((o) => o.bookWith === 'Qatar Airways');
  assert.deepEqual([qatar.url, qatar.postData], ['https://www.google.com/travel/clk/f', 'u=FIXTURE_QATAR']);
  const emt = options.find((o) => o.bookWith === 'EaseMyTrip');
  assert.deepEqual([emt.url, emt.postData], [null, null]);
});

test('separate-ticket offers are counted, not listed with half a price', () => {
  const out = mapBookingOptions(clone(BOOKING), []);
  assert.equal(out.unsupportedCount, 1);
  assert.ok(out.options.every((o) => o.bookWith !== 'Kiwi.com'));
});

test('an airline offer with a booking link but no price is kept (Alliance Air), without a made-up price', () => {
  // As SerpApi answered for Alliance Air 9I 817 BLR–HYD: the airline's own
  // Google redirect, no fare.
  const body = { booking_options: [{ together: {
    book_with: 'Alliance Air', airline: true, marketed_as: ['9I 817'],
    booking_request: { url: 'https://www.google.com/travel/clk/f', post_data: 'u=FIXTURE_9I' }
  } }] };
  const out = mapBookingOptions(body, ['Alliance Air']);
  assert.equal(out.unsupportedCount, 0);
  assert.deepEqual(out.options.map((o) => [o.bookWith, o.price, o.isAirline, o.postData]), [['Alliance Air', null, true, 'u=FIXTURE_9I']]);
  assert.equal(out.airlineOption.bookWith, 'Alliance Air');
  assert.equal(out.cheapestOption, null);

  // Priced offers still come first, and a priceless one is never "cheapest"
  const mixed = clone(BOOKING);
  mixed.booking_options.push({ together: { book_with: 'Some Agent', booking_request: { url: 'https://www.google.com/travel/clk/f', post_data: 'u=X' } } });
  const m = mapBookingOptions(mixed, ['IndiGo', 'Qatar Airways']);
  assert.equal(m.options.at(-1).bookWith, 'Some Agent');
  assert.equal(m.cheapestOption.bookWith, 'MakeMyTrip');
});

test('no booking options means none are made up', () => {
  for (const body of [{}, null, { booking_options: [] }, { booking_options: [null, { together: { book_with: 'X' } }] }]) {
    const out = mapBookingOptions(body, ['Qatar Airways']);
    assert.deepEqual(out.options, []);
    assert.equal(out.airlineOption, null);
    assert.equal(out.cheapestOption, null);
  }
});

test('search results carry the booking token Book Now needs', () => {
  const { mapGoogleFlightsResponse } = require(path.join(ROOT, 'src/utils/transformSerpApiFlights'));
  const { results } = mapGoogleFlightsResponse(clone(SEARCH));
  assert.equal(results.find((f) => f.airline === 'IndiGo').bookingToken, 'fixture-token-indigo');
});

// --- GET /api/flights/booking-options ------------------------------------------

const realGet = axios.get;
let calls;
let respond;
beforeEach(() => {
  calls = [];
  axios.get = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
});
afterEach(() => { axios.get = realGet; });

// SerpApi answers a search with SEARCH and a booking_token request with BOOKING.
const serpApi = () => (url, opts) => ({ status: 200, data: opts.params.booking_token ? BOOKING : SEARCH });

async function request(pathAndQuery) {
  const app = express();
  app.use('/api/flights', require(path.join(ROOT, 'src/routes/flights.routes')));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/flights${pathAndQuery}`);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  } finally {
    srv.close();
  }
}

test('a token asks SerpApi once, for the same search, and returns the airline\'s price', async () => {
  respond = serpApi();
  const { status, body } = await request('/booking-options?token=fixture-token-indigo&origin=BLR&destination=AMS&date=2026-10-22&cabinClass=ECONOMY&adults=1&airlines=IndiGo,Qatar%20Airways');
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  const p = calls[0].opts.params;
  assert.deepEqual([p.booking_token, p.departure_id, p.arrival_id, p.outbound_date, p.type, p.gl, p.currency, p.adults, p.travel_class],
    ['fixture-token-indigo', 'BLR', 'AMS', '2026-10-22', 2, 'in', 'INR', 1, 1]);
  assert.deepEqual([body.airlineOption.bookWith, body.airlineOption.price], ['Qatar Airways', 29134]);
  assert.deepEqual([body.cheapestOption.bookWith, body.cheapestOption.price], ['MakeMyTrip', 27005]);
  assert.equal(body.meta.source, 'live');
  assert.equal(body.meta.cached, false);
});

test('the same booking options again come from the cache, without a SerpApi request', async () => {
  respond = serpApi();
  const q = '/booking-options?token=fixture-token-etihad&origin=BLR&destination=AMS&date=2026-10-22';
  await request(q);
  const second = await request(q);
  assert.equal(second.body.meta.cached, true);
  assert.equal(calls.length, 1);
});

test('without a token the flight is found by its flight numbers in the (cached) search', async () => {
  respond = serpApi();
  const search = '&origin=BLR&destination=AMS&date=2026-10-27&adults=1';
  await request(`/search?${search.slice(1)}`); // the rider's search
  const { status, body } = await request(`/booking-options?flights=6E6123,6E23&departureTime=22:10${search}`);
  assert.equal(status, 200);
  assert.equal(calls.length, 2, 'one search, one booking-options request — the search came from cache');
  assert.equal(calls[1].opts.params.booking_token, 'fixture-token-indigo');
  assert.equal(body.airlineOption.bookWith, 'Qatar Airways');
});

test('a flight that is not in the live results is a 404 with no options', async () => {
  respond = serpApi();
  const { status, body } = await request('/booking-options?flights=AI101&origin=BLR&destination=AMS&date=2026-10-28');
  assert.equal(status, 404);
  assert.equal(body.error.reason, 'not_found');
  assert.deepEqual(body.options, []);
});

test('a SerpApi failure is a 502 with no options, and the key stays out of the answer', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: { error: 'Invalid API key.' } });
  const { status, body, text } = await request('/booking-options?token=fixture-token-x&origin=BLR&destination=AMS&date=2026-10-22');
  assert.equal(status, 502);
  assert.equal(body.error.reason, 'provider_error');
  assert.equal(body.error.message, 'Booking options could not be retrieved right now. Please try again.');
  assert.deepEqual(body.options, []);
  assert.equal(body.airlineOption, null);
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes('Invalid API key'), 'SerpApi\'s own message stays on the server');
});

test('a SerpApi failure while finding the flight (no token) is a 502 with fixed text', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  respond = () => ({ status: 200, data: { error: 'Invalid API key.' } });
  const { status, body, text } = await request('/booking-options?flights=6E1301&origin=BLR&destination=AMS&date=2026-11-03');
  assert.equal(status, 502);
  assert.equal(body.error.reason, 'provider_error');
  assert.equal(body.error.message, 'Booking options could not be retrieved right now. Please try again.');
  assert.deepEqual(body.options, []);
  assert.ok(!text.includes('Invalid API key'));
  assert.ok(!text.includes(FAKE_KEY));
});

test('without SERPAPI_KEY it is a 503, and SerpApi is not called', async (t) => {
  delete process.env.SERPAPI_KEY;
  t.after(() => { process.env.SERPAPI_KEY = FAKE_KEY; });
  const { status, body } = await request('/booking-options?token=fixture-token-indigo&origin=BLR&destination=AMS&date=2026-10-22');
  assert.equal(status, 503);
  assert.equal(body.error.reason, 'not_configured');
  assert.equal(calls.length, 0);
});

test('a missing token and flight list, or a missing search parameter, is a 400', async () => {
  respond = serpApi();
  assert.equal((await request('/booking-options?origin=BLR&destination=AMS&date=2026-10-22')).status, 400);
  assert.equal((await request('/booking-options?token=x&origin=BLR&date=2026-10-22')).status, 400);
  assert.equal(calls.length, 0);
});

// --- TravelMate.html: the card takes the airline's price ------------------------

const HTML = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');

function declaration(startPattern) {
  const start = HTML.search(startPattern);
  assert.ok(start >= 0, `not found in TravelMate.html: ${startPattern}`);
  const body = /\)\s*\{/g;
  body.lastIndex = start;
  const m = body.exec(HTML);
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`unterminated: ${startPattern}`);
}

function loadCard() {
  const context = vm.createContext({ flightSearchMeta: { adults: 1, tripType: 'one_way' } });
  vm.runInContext([
    declaration(/function formatFare\(/),
    declaration(/function flightPriceNote\(/),
    declaration(/function flightPriceNoteFor\(/),
    declaration(/function flightApplyAirlinePrice\(/),
    'this.api = { flightApplyAirlinePrice, flightPriceNoteFor };'
  ].join('\n'), context);
  return context.api;
}

function fakeCard() {
  const amount = { textContent: '₹30,010' };
  const note = { textContent: '1 adult, one way' };
  const card = { querySelector: (sel) => (sel === '.ab-from strong' ? amount : sel === '.ab-price-note' ? note : null) };
  return { btn: { closest: () => card }, amount, note };
}

test('TravelMate: once the airline\'s offer is known, the card shows that price and whose it is', () => {
  const api = loadCard();
  const f = { airline: 'IndiGo, Qatar Airways', price: 30010, currency: 'INR' };
  const { btn, amount, note } = fakeCard();
  api.flightApplyAirlinePrice(f, { bookWith: 'Qatar Airways', price: 29134, isAirline: true }, btn);
  assert.equal(f.price, 29134);
  assert.equal(amount.textContent, '₹29,134');
  assert.equal(note.textContent, 'Qatar Airways price · 1 adult, one way');
  assert.equal(api.flightPriceNoteFor(f), 'Qatar Airways price · 1 adult, one way');
});

test('TravelMate: no airline offer leaves the search price as it was', () => {
  const api = loadCard();
  const f = { price: 30010, currency: 'INR' };
  const { btn, amount } = fakeCard();
  for (const option of [null, undefined, { bookWith: 'Qatar Airways' }, { bookWith: '', price: 1 }, { bookWith: 'X', price: 0 }]) {
    api.flightApplyAirlinePrice(f, option, btn);
  }
  assert.equal(f.price, 30010);
  assert.equal(amount.textContent, '₹30,010');
  assert.equal(api.flightPriceNoteFor(f), '1 adult, one way');
});

test('TravelMate: Book Now sends the itinerary\'s airlines and applies the airline\'s offer, not the cheapest agent', () => {
  const bookNow = declaration(/async function flightBookNow\(/);
  assert.match(bookNow, /airlines: \(Array\.isArray\(f\.airlines\)/);
  assert.match(bookNow, /flightApplyAirlinePrice\(f, pick && pick\.isAirline \? pick : body\.airlineOption, btn\)/);
  assert.doesNotMatch(bookNow, /cheapestOption/);
});

test('TravelMate: the Book Now tab says what is happening and offers the airline straight away', () => {
  // escapeHtml() uses the DOM's own escaping; this stands in for it
  const document = { createElement: () => { let t = ''; return { set textContent(v) { t = String(v); }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; } };
  const context = vm.createContext({ document });
  vm.runInContext([
    /const escapeAttr = .+;/.exec(HTML)[0],
    declaration(/function escapeHtml\(/),
    declaration(/function flightBookingTabHtml\(/),
    'this.api = { flightBookingTabHtml };'
  ].join('\n'), context);
  const html = context.api.flightBookingTabHtml('Air India', 'https://www.airindia.com/');
  assert.match(html, /<title>Opening Air India · TravelMate<\/title>/);
  assert.match(html, /Opening Air India's booking page…/);
  assert.match(html, /<a href="https:\/\/www\.airindia\.com\/">Don't want to wait\? Go to Air India's website<\/a>/);
  assert.doesNotMatch(html, /with your flight selected/);
  // Only an https link is offered, and names can't inject markup
  assert.doesNotMatch(context.api.flightBookingTabHtml('X', 'javascript:alert(1)'), /<a /);
  assert.doesNotMatch(context.api.flightBookingTabHtml('<b>Air</b>', ''), /<b>/);
});
