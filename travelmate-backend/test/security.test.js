// Security regressions: request limits and input checks on the routes that
// spend paid API credits, API keys staying server-side, and provider text
// being escaped in the train and flight cards. Offline: axios is stubbed to
// fail the test if any provider request is attempted.

const { test, before, after, beforeEach } = require('node:test');
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
const HTML = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');
const FAKE_KEY = 'fake-serpapi-key-for-security-tests';

const { createRateLimiter, parseLimit, flightsLimiter, trainsLimiter } = require(path.join(ROOT, 'src/middleware/rateLimit'));

// --- the limiter on its own ----------------------------------------------------

function fakeRes() {
  return {
    headers: {}, statusCode: 200, body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(s) { this.statusCode = s; return this; },
    json(b) { this.body = b; return this; }
  };
}

test('rate limiter: allows the limit, then answers 429 with Retry-After and the route\'s own body', (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = createRateLimiter({ name: 'test', max: () => 2, body: (req, s) => ({ error: { status: 429, reason: 'rate_limited' }, results: [], retry: s }) });
  let passed = 0;
  const next = () => { passed += 1; };
  const req = { ip: '203.0.113.5', method: 'GET' };
  limiter(req, fakeRes(), next);
  limiter(req, fakeRes(), next);
  const blocked = fakeRes();
  limiter(req, blocked, next);
  assert.equal(passed, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.error.reason, 'rate_limited');
  assert.deepEqual(blocked.body.results, []);
  assert.ok(Number(blocked.headers['Retry-After']) >= 1 && Number(blocked.headers['Retry-After']) <= 60);
  assert.equal(blocked.headers['RateLimit-Remaining'], '0');
});

test('rate limiter: each client IP has its own count', (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = createRateLimiter({ name: 'test', max: () => 1, body: () => ({}) });
  let passed = 0;
  limiter({ ip: '198.51.100.1' }, fakeRes(), () => { passed += 1; });
  limiter({ ip: '198.51.100.2' }, fakeRes(), () => { passed += 1; });
  const blocked = fakeRes();
  limiter({ ip: '198.51.100.1' }, blocked, () => { passed += 1; });
  assert.equal(passed, 2);
  assert.equal(blocked.statusCode, 429);
});

test('rate limiter: the count starts again when the window ends', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = createRateLimiter({ name: 'test', max: () => 1, windowMs: 40, body: () => ({}) });
  let passed = 0;
  const next = () => { passed += 1; };
  limiter({ ip: '192.0.2.9' }, fakeRes(), next);
  limiter({ ip: '192.0.2.9' }, fakeRes(), next);
  await new Promise((r) => setTimeout(r, 60));
  limiter({ ip: '192.0.2.9' }, fakeRes(), next);
  assert.equal(passed, 2);
});

test('rate limit settings: whole numbers >= 1 only; anything else keeps the default (never "off")', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(parseLimit(undefined, 60, 'X'), 60);
  assert.equal(parseLimit('', 60, 'X'), 60);
  assert.equal(parseLimit(' 25 ', 60, 'X'), 25);
  for (const bad of ['0', '-5', 'abc', '1.5', 'Infinity']) assert.equal(parseLimit(bad, 60, 'X'), 60, bad);
});

test('rate limiter: memory stays bounded — at most maxClients clients, the oldest window forgotten first', (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = createRateLimiter({ name: 'test', max: () => 1, maxClients: 3, body: () => ({}) });
  const hit = (ip) => {
    let passed = false;
    const res = fakeRes();
    limiter({ ip, method: 'GET' }, res, () => { passed = true; });
    return passed ? 'pass' : res.statusCode;
  };
  for (let i = 0; i < 50; i++) hit(`198.51.100.${i}`); // 50 different clients within one window
  assert.equal(limiter.size(), 3, 'never more than maxClients entries');
  assert.equal(hit('198.51.100.49'), 429, 'a remembered client stays limited');
  assert.equal(hit('198.51.100.0'), 'pass', 'the oldest was forgotten, so it starts a new window');
  assert.equal(limiter.size(), 3);
});

test('rate limiter: expired windows are dropped as new clients arrive', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = createRateLimiter({ name: 'test', max: () => 5, windowMs: 30, body: () => ({}) });
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) limiter({ ip }, fakeRes(), () => {});
  assert.equal(limiter.size(), 3);
  await new Promise((r) => setTimeout(r, 45));
  limiter({ ip: '192.0.2.4' }, fakeRes(), () => {});
  assert.equal(limiter.size(), 1, 'only the new client is left');
});

test('rate limiter: a refusal is logged once per client per window, without the client address or the URL', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const limiter = createRateLimiter({ name: 'flights', max: () => 1, body: () => ({}) });
  const req = { ip: '203.0.113.77', method: 'GET', originalUrl: '/api/flights/booking-options?token=secret-token&origin=BLR' };
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = fakeRes();
    limiter(req, res, () => {});
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [200, 429, 429, 429, 429, 429]);
  assert.equal(warnings.length, 1, 'one line, not one per refused request');
  assert.match(warnings[0], /\[rate-limit\] flights: limit of 1\/min reached for a client/);
  assert.doesNotMatch(warnings[0], /203\.0\.113\.77|secret-token|token=|booking-options/);
});

// --- the limiter and input checks on the real routes -------------------------

let srv;
let base;
let providerCalls;
const realGet = axios.get;

before(async () => {
  process.env.SERPAPI_KEY = FAKE_KEY;
  const app = express();
  app.use('/api/flights', require(path.join(ROOT, 'src/routes/flights.routes')));
  app.use('/api/trains', require(path.join(ROOT, 'src/routes/trains.routes')));
  app.use(require(path.join(ROOT, 'src/middleware/errorHandler')).errorHandler);
  srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  base = `http://127.0.0.1:${srv.address().port}/api`;
  axios.get = async (url) => { providerCalls.push(url); throw new Error('no provider request may be sent in these tests'); };
});

after(() => {
  srv.close();
  axios.get = realGet;
  delete process.env.FLIGHT_RATE_LIMIT_PER_MINUTE;
  delete process.env.TRAIN_RATE_LIMIT_PER_MINUTE;
});

beforeEach(() => {
  providerCalls = [];
  flightsLimiter.reset();
  trainsLimiter.reset();
  delete process.env.FLIGHT_RATE_LIMIT_PER_MINUTE;
  delete process.env.TRAIN_RATE_LIMIT_PER_MINUTE;
});

async function get(p) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('flights: search and booking options share one limit, and a blocked request never reaches SerpApi', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.FLIGHT_RATE_LIMIT_PER_MINUTE = '2';
  // Invalid requests still count (they're refused before SerpApi either way)
  assert.equal((await get('/flights/search?origin=BLR')).status, 400);
  assert.equal((await get('/flights/booking-options?origin=BLR')).status, 400);
  const blocked = await get('/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.reason, 'rate_limited');
  assert.deepEqual(blocked.body.results, []);
  assert.deepEqual(blocked.body.options, []);
  assert.equal(blocked.body.meta.source, 'unavailable');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(providerCalls.length, 0);
});

test('trains: search and schedule share one limit', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.TRAIN_RATE_LIMIT_PER_MINUTE = '1';
  assert.equal((await get('/trains/schedule?train=abc')).status, 400);
  const blocked = await get('/trains/search?from=SBC&to=HYB&date=2026-10-30');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.reason, 'rate_limited');
  assert.deepEqual(blocked.body.results, []);
  assert.equal(providerCalls.length, 0);
});

test('trains: station autocomplete is not limited (it calls no provider)', async () => {
  process.env.TRAIN_RATE_LIMIT_PER_MINUTE = '1';
  for (let i = 0; i < 3; i++) assert.equal((await get('/trains/stations?q=Bengaluru')).status, 200);
});

test('flights: a date more than a year ahead is refused before any SerpApi request', async () => {
  const { latestSearchDate } = require(path.join(ROOT, 'src/routes/flights.routes'));
  const tooLate = new Date(Date.parse(latestSearchDate()) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const res = await get(`/flights/search?origin=BLR&destination=DEL&departureDate=${tooLate}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /at most 366 days ahead/);
  const booking = await get(`/flights/booking-options?token=abc&origin=BLR&destination=DEL&date=${tooLate}`);
  assert.equal(booking.status, 400);
  assert.equal(providerCalls.length, 0);
});

test('flights: a return date before the departure date is refused', async () => {
  const res = await get('/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22&returnDate=2026-11-20');
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /cannot be before/);
  assert.equal(providerCalls.length, 0);
});

test('flights: a booking token with characters no SerpApi token has is refused', async () => {
  for (const token of ['abc<script>', 'a b', 'tok"en', 'x;y']) {
    const res = await get(`/flights/booking-options?token=${encodeURIComponent(token)}&origin=BLR&destination=AMS&date=2026-11-22`);
    assert.equal(res.status, 400, token);
    assert.match(res.body.error.message, /not a valid booking token/);
  }
  assert.equal(providerCalls.length, 0);
});

// --- API keys stay on the server --------------------------------------------

test('server.js reads .env from its own folder, and the key only from SERPAPI_KEY', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /require\('dotenv'\)\.config\(\{ path: require\('path'\)\.join\(__dirname, '\.env'\) \}\)/);
  const service = fs.readFileSync(path.join(ROOT, 'src/services/serpapi.service.js'), 'utf8');
  assert.match(service, /const apiKey = process\.env\.SERPAPI_KEY;/);
});

test('no frontend file holds an API key or calls a paid provider directly', () => {
  for (const file of [path.join(ROOT, '..', 'TravelMate.html'), path.join(ROOT, 'public', 'index.html')]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /SERPAPI_(API_)?KEY|RAPIDAPI_KEY|x-rapidapi-key|[?&]api_key=/i, file);
    assert.doesNotMatch(text, /https:\/\/(serpapi\.com|[a-z0-9.-]*\.rapidapi\.com)/i, file);
  }
});

// --- provider text is escaped in the cards -----------------------------------

// The source of one top-level declaration, matched up to its closing brace.
function declaration(startPattern) {
  const start = HTML.search(startPattern);
  assert.ok(start >= 0, `not found in TravelMate.html: ${startPattern}`);
  let open = HTML.indexOf('{', start);
  if (/^(async\s+)?function\b/.test(HTML.slice(start, start + 20))) {
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
const line = (re) => re.exec(HTML)[0];

const HOSTILE = '<img src=x onerror=alert(1)>';
// No raw tag or unquoted handler may survive; escaped text (&lt;img ...) is fine.
function assertNoMarkupInjected(html) {
  assert.doesNotMatch(html, /<img src=x|<script|<svg|<b>|<i>/i);
  assert.doesNotMatch(html, /"\s*onmouseover=|"><b/);
}

function loadTrainCard() {
  const context = vm.createContext({
    trainCardStations: (t) => ({ from: t.fromStation, to: t.toStation }),
    parseRunningDays: () => [true, true, true, true, true, true, true],
    addDaysToISO: () => null, formatDayDate: () => '', trainSourceTag: () => ''
  });
  vm.runInContext([
    line(/const tmEsc = .+;/), line(/const tmClassPart = .+;/), line(/const IRCTC_SEAT_NOTE = .+;/), line(/const WEEKDAY_LETTERS = .+;/),
    declaration(/function trainCardStationCodes\(/), declaration(/function trainTypeBadgeClass\(/),
    declaration(/function formatTime12hr\(/), declaration(/function renderTrainCard\(/),
    'this.api = { renderTrainCard, tmEsc };'
  ].join('\n'), context);
  return context.api;
}

test('train card: provider names, stations, times and classes cannot inject markup', () => {
  const { renderTrainCard } = loadTrainCard();
  const html = renderTrainCard({
    trainNumber: '12" onmouseover="x', trainName: HOSTILE, trainType: 'Rajdhani"><b>x', duration: '<i>9h</i>',
    departureTime: '<script>1</script>', arrivalTime: '07:10', days: 'Runs Daily',
    fromStation: '<svg onload=x> (SBC)', toStation: 'Kacheguda (KCG)',
    classes: [{ cls: '3A"><b>', fare: '<b>905</b>', live: true, tier: 'available" onmouseover="y', status: '<svg/onload=z>' }]
  }, { date: '2026-10-30', from: 'SBC', to: 'KCG' });
  assertNoMarkupInjected(html);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the name is shown as text');
  assert.match(html, /data-train="12&quot; onmouseover=&quot;x"/);
  assert.match(html, /class="avl-available-onmouseovery"/, 'class names keep only safe characters');
  assert.match(html, /class="train-type-badge train-type-rajdhanibx"/);
});

test('train card: ordinary text is shown exactly as before', () => {
  const { renderTrainCard } = loadTrainCard();
  const html = renderTrainCard({
    trainNumber: '12627', trainName: 'Karnataka Express', trainType: 'Superfast', duration: '9h 05m',
    departureTime: '19:20', arrivalTime: '04:25 (+1)', days: 'Runs Daily',
    fromStation: 'KSR Bengaluru City Junction (SBC)', toStation: 'Kacheguda (KCG)',
    classes: [{ cls: 'SL', fare: 420, live: false }, { cls: '3A', fare: 1125, live: true, tier: 'available', status: 'AVAILABLE-0042' }]
  }, { date: '2026-10-30', from: 'SBC', to: 'KCG' });
  assert.match(html, /<div class="ab-op-name">Karnataka Express<\/div>/);
  assert.match(html, /<div class="ab-op-type">#12627<\/div>/);
  assert.match(html, /<span>KSR Bengaluru City Junction \(SBC\)<\/span>/);
  assert.match(html, /<strong>7:20 PM<\/strong>/);
  assert.match(html, /data-train="12627" data-from="SBC" data-to="KCG" data-date="2026-10-30"/);
  assert.match(html, /<span class="avl-available">AVAILABLE-0042<\/span>/);
  assert.match(html, /<span class="fare">₹420 \(est\.\)<\/span>/);
  assert.match(html, /class="train-type-badge train-type-superfast">Superfast</);
});

function loadFlightCard() {
  const context = vm.createContext({
    flightFromLabel: 'Bengaluru (BLR)', flightToLabel: 'Amsterdam <AMS>',
    flightPriceNoteFor: () => '', escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    airlineBookingSite: (f) => ({ name: f.airline }), AIRLINE_NAME_CODES: {}
  });
  vm.runInContext([
    line(/const tmEsc = .+;/),
    declaration(/function formatTime12hr\(/), declaration(/function nextDayLabel\(/), declaration(/function emissionsTagHtml\(/),
    declaration(/function formatFare\(/), declaration(/function airlineIataCode\(/), declaration(/function airlineInitials\(/),
    declaration(/function airlineLogoHtml\(/), declaration(/function flightCardLogos\(/), declaration(/function renderFlightCard\(/),
    declaration(/function getFlightSegments\(/), declaration(/function formatDetailDate\(/), declaration(/function amenityIcon\(/),
    declaration(/function renderFlightSegment\(/), declaration(/function renderFlightDetailContent\(/),
    'this.api = { renderFlightCard, renderFlightDetailContent, airlineLogoHtml };'
  ].join('\n'), context);
  return context.api;
}

const HOSTILE_FLIGHT = {
  airline: 'Qatar"><b>Airways', flightNumber: '<svg onload=x>', stops: 1, stopCity: HOSTILE, duration: '<i>16h</i>',
  departureTime: '21:10', arrivalTime: '<script>x</script>', price: 29134, currency: 'INR', cabinClass: 'ECONOMY"><b>',
  airlineLogo: 'javascript:alert(1)',
  carbonEmissions: { thisFlightKg: '<b>380</b>', differencePercent: 3 },
  segments: [{
    airline: HOSTILE, flightNumber: 'QR 283', travelClass: 'Economy', aircraft: '<b>A350</b>', duration: '<i>4h</i>',
    departureTime: '21:10', arrivalTime: '23:40', departureAirportName: '<svg onload=a>', departureAirport: 'BLR',
    arrivalAirportName: 'Hamad <b>Intl</b>', arrivalAirport: 'DOH', legroom: '<i>79 cm</i>', extensions: ['<img src=x onerror=e>'],
    airlineLogo: 'https://www.gstatic.com/flights/airline_logos/70px/QR.png?a=1&b="2',
    layoverAfter: { duration: '<b>2h</b>', airportName: HOSTILE, airport: 'DOH', durationMinutes: 120 }
  }]
};

test('flight card: provider airline, flight number, stop city and duration cannot inject markup', () => {
  const html = loadFlightCard().renderFlightCard(HOSTILE_FLIGHT, 0);
  assertNoMarkupInjected(html);
  assert.match(html, /Qatar&quot;&gt;&lt;b&gt;Airways/);
  assert.match(html, /Amsterdam &lt;AMS&gt;/, 'the searched place label is escaped too');
});

test('flight details: segment, layover, amenity and emissions text cannot inject markup', () => {
  const html = loadFlightCard().renderFlightDetailContent(HOSTILE_FLIGHT);
  assertNoMarkupInjected(html);
  assert.match(html, /Hamad &lt;b&gt;Intl&lt;\/b&gt;/);
});

test('airline logo: only an https:// logo is used, and its address is escaped, not broken', () => {
  const { airlineLogoHtml } = loadFlightCard();
  const scripted = airlineLogoHtml('Qatar Airways', 'QR 283', 'javascript:alert(1)');
  assert.doesNotMatch(scripted, /javascript:/);
  assert.match(scripted, /src="https:\/\/www\.gstatic\.com\/flights\/airline_logos\/70px\/QR\.png"/, 'falls back to the logo for the IATA code');
  const quoted = airlineLogoHtml('Q"R', 'QR 283', 'https://example.com/logo.png?a=1&b="2');
  assert.match(quoted, /src="https:\/\/example\.com\/logo\.png\?a=1&amp;b=&quot;2"/);
  assert.match(quoted, /title="Q&quot;R"/);
});

test('flight card: ordinary text is shown exactly as before', () => {
  const html = loadFlightCard().renderFlightCard({
    airline: 'IndiGo', flightNumber: '6E 1301', stops: 0, duration: '2h 45m', departureTime: '06:15', arrivalTime: '09:00',
    price: 5432, currency: 'INR', cabinClass: 'ECONOMY'
  }, 3);
  assert.match(html, /<\/span>IndiGo<\/div>/);
  assert.match(html, /<div class="ab-op-type">6E 1301<\/div>/);
  assert.match(html, /<div class="ab-op-origin">Nonstop<\/div>/);
  assert.match(html, /<strong>₹5,432<\/strong>/);
  assert.match(html, /<strong>6:15 AM<\/strong>/);
  assert.match(html, /onclick="flightBookNow\(3, this\)" title="Book on IndiGo"/);
});

// --- past travel dates never reach a provider --------------------------------

test('flights: a past departure or return date is a 400 that says so, before any SerpApi request', async () => {
  const past = await get('/flights/search?origin=BLR&destination=DEL&departureDate=2026-10-01');
  assert.equal(past.status, 400);
  assert.equal(past.body.error.message, '"departureDate" (2026-10-01) is in the past — choose today or a later date.');
  const pastReturn = await get('/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22&returnDate=10-10-2026');
  assert.equal(pastReturn.status, 400);
  assert.match(pastReturn.body.error.message, /"returnDate" \(2026-10-10\) is in the past/);
  const booking = await get('/flights/booking-options?token=abc&origin=BLR&destination=AMS&date=2026-10-01');
  assert.equal(booking.status, 400);
  const impossible = await get('/flights/search?origin=BLR&destination=DEL&departureDate=2026-02-31');
  assert.equal(impossible.body.error.message, 'A valid "departureDate" is required, as YYYY-MM-DD or DD-MM-YYYY.');
  assert.equal(providerCalls.length, 0);
});

test('trains: a past date is a 400 for search and seat refresh, before any IRCTC or erail request', async () => {
  const search = await get('/trains/search?from=SBC&to=HYB&date=2026-10-01');
  assert.equal(search.status, 400);
  assert.equal(search.body.error.message, '"date" (2026-10-01) is in the past — choose today or a later date.');
  const refresh = await get('/trains/class-availability?trainNumber=12649&classType=SL&from=YPR&to=KCG&date=2026-10-01');
  assert.equal(refresh.status, 400);
  assert.match(refresh.body.error.message, /is in the past/);
  assert.equal(providerCalls.length, 0);
});

// --- the real server: network binding, origins, and where the app is opened ---

const { startServer } = require('./helpers/server');
const { parseOriginList, apiOriginGuard, defaultOrigins } = require(path.join(ROOT, 'src/middleware/originPolicy'));
const net = require('node:net');
const os = require('node:os');

let app;
before(async () => { app = await startServer(); });
after(() => app && app.stop());

const port = () => new URL(app.baseUrl).port;
async function api(p, headers = {}, init = {}) {
  const res = await fetch(`${app.baseUrl}${p}`, { headers, ...init });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body };
}

test('the app is served at / (and /TravelMate.html) by the backend, marked to call the API on its own origin', async () => {
  const file = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');
  const marker = '<meta name="travelmate-api-base" content="same-origin">';
  assert.ok(!file.includes(marker), 'the file itself has no marker, so opened directly it keeps calling http://localhost:3000');
  for (const p of ['/', '/TravelMate.html']) {
    const res = await fetch(`${app.baseUrl}${p}`);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html; charset=utf-8/);
    const html = await res.text();
    assert.equal(html, file.replace('<head>', `<head>\n${marker}`), `${p} is TravelMate.html plus the marker`);
    assert.equal(html.split(marker).length - 1, 1, 'the marker appears once');
    assert.ok(html.indexOf(marker) < html.indexOf('<title>'), 'the marker is in the document head');
  }
  assert.match(app.output(), /Open the TravelMate app at http:\/\/localhost:\d+\//);
});

test('the page calls the API on its own origin only when the backend served it; otherwise http://localhost:3000', () => {
  const line = /const TM_API_BASE = .+;/.exec(HTML)[0];
  const base = (context) => vm.runInNewContext(`${line}\nTM_API_BASE`, context);
  const page = (href, marked) => ({
    location: { protocol: new URL(href).protocol, origin: new URL(href).origin },
    document: { querySelector: (sel) => (marked && sel === 'meta[name="travelmate-api-base"][content="same-origin"]' ? {} : null) }
  });
  assert.equal(base(page('http://localhost:3000/', true)), 'http://localhost:3000', 'served by the backend on the default port');
  assert.equal(base(page('http://127.0.0.1:4000/TravelMate.html', true)), 'http://127.0.0.1:4000', 'another host or PORT: its own origin');
  assert.equal(base(page('https://travelmate.example/', true)), 'https://travelmate.example', 'a deployment behind a proxy');
  assert.equal(base(page('file:///C:/travelmate/TravelMate.html', false)), 'http://localhost:3000', 'opened as a file: the local backend, as before');
  assert.equal(base(page('http://localhost:5500/TravelMate.html', false)), 'http://localhost:3000', 'another static server (ALLOWED_ORIGINS): the local backend');
  assert.equal(base(page('file:///C:/travelmate/TravelMate.html', true)), 'http://localhost:3000', 'the marker only counts over http(s)');
  assert.equal(base({}), 'http://localhost:3000', 'no page at all (scripts, the other tests)');
});

test('every API call in the page goes through TM_API_BASE — no hard-coded backend address is left', () => {
  const calls = HTML.match(/fetch(WithTimeout)?\(`[^`]*\/api\/[a-z-]+\/[a-z-]+/g) || [];
  assert.equal(calls.length, 9, 'the nine API calls');
  for (const call of calls) assert.match(call, /\(`\$\{TM_API_BASE\}\/api\//, call);
  assert.doesNotMatch(HTML, /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api\//, 'no hard-coded API URL');
});

test('the old frontend (public/index.html) is not served: /index.html and every file in public/ are 404s', async () => {
  const oldPage = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(oldPage.length > 0, 'the old copy stays on disk, for reference');
  const paths = new Set(['/index.html', '/public/index.html',
    ...fs.readdirSync(path.join(ROOT, 'public')).map((name) => `/${encodeURIComponent(name)}`)]);
  for (const p of paths) {
    const res = await fetch(`${app.baseUrl}${p}`);
    const text = await res.text();
    assert.equal(res.status, 404, p);
    assert.notEqual(text, oldPage, `${p} must not return the old page`);
    assert.doesNotMatch(text, /flight-airline-name|\$\{f\.airline\}/, `${p} must not contain the old card templates`);
  }
  // The current app and the API are unaffected
  assert.equal((await fetch(`${app.baseUrl}/`)).status, 200);
  assert.equal((await api('/api/health')).status, 200);
});

test('the only page served escapes the provider fields the old page left raw (airline, stop city, train name)', async () => {
  const served = await (await fetch(`${app.baseUrl}/`)).text();
  assert.doesNotMatch(served, /<div class="flight-airline-name">\$\{f\.airline\}<\/div>/, 'not the old unescaped airline template');
  assert.match(served, /<\/span>\$\{tmEsc\(f\.airline\)\}<\/div>/);
  assert.match(served, /· \$\{tmEsc\(f\.stopCity\)\}/);
  assert.match(served, /<div class="ab-op-name">\$\{tmEsc\(t\.trainName\)\}<\/div>/);
  // (The rendering tests above feed these same templates hostile provider text.)
});

test('flight-booking-options.js is never loaded or served, and nothing that runs reads SERPAPI_API_KEY', async () => {
  const runtimeFiles = [path.join(ROOT, 'server.js'),
    ...fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'src', f))];
  assert.ok(runtimeFiles.length > 10, 'the backend source files were found');
  for (const file of runtimeFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /flight-booking-options/, `${path.relative(ROOT, file)} must not load it`);
    assert.doesNotMatch(text, /SERPAPI_API_KEY/, `${path.relative(ROOT, file)} must not read SERPAPI_API_KEY`);
  }
  assert.doesNotMatch(HTML, /SERPAPI_API_KEY|flight-booking-options/, 'the page never mentions either');
  for (const p of ['/flight-booking-options.js', '/travelmate-backend/flight-booking-options.js', '/server.js', '/package.json',
    '/.env', '/travelmate-backend/.env', '/src/routes/flights.routes.js']) {
    assert.equal((await fetch(`${app.baseUrl}${p}`)).status, 404, `${p} is not served`);
  }
});

test('origins: the app\'s own localhost origins are answered, with CORS headers for them only', async () => {
  for (const origin of [`http://localhost:${port()}`, `http://127.0.0.1:${port()}`]) {
    const res = await api('/api/health', { Origin: origin });
    assert.equal(res.status, 200, origin);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
  }
  const plain = await api('/api/health');
  assert.equal(plain.status, 200, 'no Origin (curl, scripts) is fine');
  assert.equal(plain.headers.get('access-control-allow-origin'), null, 'no wildcard CORS header any more');
  assert.equal((await api('/api/health', { 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'the app\'s own same-origin requests');
});

test('origins: Origin null (a page opened as a file, a sandboxed frame) is refused with a 403', async () => {
  const res = await api('/api/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22', { Origin: 'null' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.reason, 'origin_not_allowed');
  assert.match(res.body.error.message, /Open it at http:\/\/localhost:\d+\//);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('origins: another website is refused — by Origin, by Sec-Fetch-Site, and on preflight', async () => {
  const other = await api('/api/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22', { Origin: 'https://evil.example' });
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const sameHostOtherPort = await api('/api/health', { Origin: 'http://localhost:5500' });
  assert.equal(sameHostOtherPort.status, 403, 'not listed by default');
  const blind = await api('/api/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(blind.status, 403, 'an <img>/<script> on another site sends no Origin, only Sec-Fetch-Site');
  const preflight = await api('/api/flights/search', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' }, { method: 'OPTIONS' });
  assert.equal(preflight.status, 403);
});

test('origins: a refused request never reaches a route or uses up the rate limit', async () => {
  const limited = await startServer({ env: { FLIGHT_RATE_LIMIT_PER_MINUTE: '1' } });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${limited.baseUrl}/api/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22`, { headers: { Origin: 'https://evil.example' } });
      assert.equal(res.status, 403);
    }
    const own = await limited.get('/api/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22');
    assert.equal(own.status, 503, 'reaches the route (no SerpApi key in tests), not 429');
    assert.equal(own.body.error.reason, 'not_configured');
  } finally {
    await limited.stop();
  }
});

test('origins: ALLOWED_ORIGINS replaces the list, but can never allow "null"', async () => {
  const custom = await startServer({ env: { ALLOWED_ORIGINS: 'http://localhost:5500, null' } });
  try {
    const call = (origin) => fetch(`${custom.baseUrl}/api/health`, { headers: { Origin: origin } });
    assert.equal((await call('http://localhost:5500')).status, 200);
    assert.equal((await call('null')).status, 403);
    assert.match(custom.output(), /ALLOWED_ORIGINS lists "null" — ignored/);
  } finally {
    await custom.stop();
  }
});

test('ALLOWED_ORIGINS entries must be exact http(s) origins', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual([...parseOriginList('http://localhost:5500,https://travelmate.example')], ['http://localhost:5500', 'https://travelmate.example']);
  assert.deepEqual([...parseOriginList('null, *, http://x.example/path, ftp://x.example, localhost:5500')], []);
});

test('origins: the guard, case by case — without Origin, only the app itself, the user or a non-browser client passes', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const [ownLocalhost, own127] = defaultOrigins();
  const decide = (headers) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method: 'GET', originalUrl: '/api/flights/search?origin=BLR', get: (name) => lower[name.toLowerCase()] };
    const res = fakeRes();
    let passed = false;
    apiOriginGuard(req, res, () => { passed = true; });
    return passed ? 'pass' : res.statusCode;
  };
  const cases = [
    [{}, 'pass', 'curl, scripts, older browsers'],
    [{ 'Sec-Fetch-Site': 'same-origin' }, 'pass', 'the app at its own address'],
    [{ 'Sec-Fetch-Site': 'none' }, 'pass', 'a typed URL or a bookmark'],
    [{ 'Sec-Fetch-Site': 'same-site' }, 403, 'another localhost port — an <img> or no-cors fetch'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'another website — an <img> or no-cors fetch'],
    [{ 'Sec-Fetch-Site': 'something-else' }, 403, 'an unexpected value'],
    [{ Origin: ownLocalhost, 'Sec-Fetch-Site': 'same-origin' }, 'pass', 'the app, with an Origin header'],
    [{ Origin: own127, 'Sec-Fetch-Site': 'cross-site' }, 'pass', 'the app opened at 127.0.0.1, calling localhost'],
    [{ Origin: 'http://localhost:5500', 'Sec-Fetch-Site': 'same-site' }, 403, 'another localhost port, not listed'],
    [{ Origin: 'null' }, 403, 'a page opened as a file'],
    [{ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, 403, 'Origin null, whatever else is sent']
  ];
  for (const [headers, expected, why] of cases) assert.equal(decide(headers), expected, `${why}: ${JSON.stringify(headers)}`);
  assert.ok(warnings.some((w) => w.includes('Refused GET /api/flights/search?origin=BLR from a "same-site" request without an Origin header.')));
});

test('origins: another localhost port can\'t trigger a paid search without an Origin header (real server)', async () => {
  const search = '/api/flights/search?origin=BLR&destination=DEL&departureDate=2026-11-22';
  const sameSite = await api(search, { 'Sec-Fetch-Site': 'same-site' });
  assert.equal(sameSite.status, 403, 'an <img> or no-cors fetch on e.g. http://localhost:5500');
  assert.equal(sameSite.body.error.reason, 'origin_not_allowed');
  assert.equal((await api('/api/health', { 'Sec-Fetch-Site': 'none' })).status, 200, 'a typed URL still works');
  assert.equal((await api(search, { 'Sec-Fetch-Site': 'same-origin' })).status, 503, 'the app\'s own search reaches the route (no SerpApi key in tests)');
});

test('binding: the server listens on 127.0.0.1 by default, not on this computer\'s network addresses', async (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(source, /const HOST = \(process\.env\.HOST \|\| ''\)\.trim\(\) \|\| '127\.0\.0\.1';/);
  assert.match(source, /app\.listen\(PORT, HOST,/);
  assert.match(app.output(), /listening on http:\/\/127\.0\.0\.1:\d+/);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('this computer has no non-loopback IPv4 address to try');
  const reached = await new Promise((resolve) => {
    const socket = net.connect({ host: lan.address, port: Number(port()) });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  assert.equal(reached, false, 'not reachable on the network address');
});

test('buses: a past date is a 400 that says so (real server)', async () => {
  const res = await api('/api/buses/search?from=Bengaluru&to=Chennai&date=2026-10-01');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.message, '"date" (2026-10-01) is in the past — choose today or a later date.');
});

test('TRAVELMATE_TODAY is ignored, with a startup warning, outside NODE_ENV=test (real server)', async () => {
  // Valid with the tests' pinned day (2026-10-20), but in the past by the real date
  const search = '/api/buses/search?from=Bengaluru&to=Chennai&date=2026-10-21';
  assert.equal((await api(search)).status, 200, 'the test server honours the pinned day');
  const production = await startServer({ env: { NODE_ENV: 'production', TRAVELMATE_TODAY: '2026-10-20' } });
  try {
    const res = await production.get(search);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, '"date" (2026-10-21) is in the past — choose today or a later date.');
    const deadline = Date.now() + 3000; // the warning goes to stderr, which can arrive a moment later
    while (!/TRAVELMATE_TODAY is set but ignored/.test(production.output()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.match(production.output(), /TRAVELMATE_TODAY is set but ignored: it only applies when NODE_ENV=test/);
  } finally {
    await production.stop();
  }
});

test('TravelMate.html opened as a file goes to http://localhost:3000/ instead; served over http it stays put', () => {
  const block = /<script>\s*\/\/ Opened as a file[\s\S]*?<\/script>/.exec(HTML);
  assert.ok(block, 'file:// redirect script not found');
  const code = block[0].replace(/^<script>|<\/script>$/g, '');
  const run = (protocol) => {
    const went = [];
    vm.runInNewContext(code, { location: { protocol, replace: (url) => went.push(url) } });
    return went;
  };
  assert.deepEqual(run('file:'), ['http://localhost:3000/']);
  assert.deepEqual(run('http:'), []);
});
