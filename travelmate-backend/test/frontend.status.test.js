// TravelMate.html's live / cached / demo indicators, request timeouts and the
// bus tab's backend call — the page's real functions, run in a sandbox with a
// stubbed fetch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'TravelMate.html'), 'utf8');

// The source of one top-level declaration, matched up to its closing brace.
// A function's body starts at the "{" after its parameter list, so a
// destructured parameter ("{ cached = false }") isn't mistaken for the body.
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

function load(extra = {}) {
  const context = vm.createContext({ URLSearchParams, AbortSignal, Error, ...extra });
  vm.runInContext([
    /const TM_API_BASE = .+;/.exec(HTML)[0],
    /const TM_OPENED_AS_FILE = .+;/.exec(HTML)[0],
    /const TM_FILE_REASON = .+;/.exec(HTML)[0],
    /const escapeAttr = .+;/.exec(HTML)[0],
    /const tmEsc = .+;/.exec(HTML)[0],
    /const busShortName = .+;/.exec(HTML)[0],
    declaration(/function dataStatusChip\(/),
    declaration(/const SEARCH_TIMEOUT_MS = \{/),
    declaration(/async function fetchWithTimeout\(/),
    declaration(/function flightUpdatedLabel\(/),
    declaration(/function priceInsightHtml\(/),
    declaration(/function trainDataStatus\(/),
    declaration(/function trainFetchedLabel\(/),
    declaration(/function trainDataStatusHtml\(/),
    declaration(/async function fetchLiveBuses\(/),
    declaration(/function busDataStatusHtml\(/),
    'this.api = { SEARCH_TIMEOUT_MS, fetchWithTimeout, priceInsightHtml, trainDataStatus, trainDataStatusHtml, fetchLiveBuses, busDataStatusHtml };'
  ].join('\n'), context);
  return context.api;
}

const FLIGHTS = [{ price: 11218 }, { price: 10357 }, { price: 12900 }];

// --- flights -----------------------------------------------------------------

test('flights: a live answer shows "Live" and when it was fetched, not demo', () => {
  const html = load().priceInsightHtml(FLIGHTS, true, { retrievedAt: '2026-10-22T05:12:00.000Z' });
  assert.match(html, /data-status-live[^>]*>Live</);
  assert.match(html, /class="flight-updated">Updated \d{1,2}:\d{2}\s?[ap]m</i);
  assert.doesNotMatch(html, /demo/i);
  assert.doesNotMatch(html, /Cached/);
});

test('flights: a cached live answer also shows "Cached"', () => {
  const html = load().priceInsightHtml(FLIGHTS, true, { cached: true });
  assert.match(html, />Live</);
  assert.match(html, /data-status-cached[^>]*>Cached</);
});

test('flights: only Google\'s own price insights call prices low / typical / high', () => {
  const api = load();
  const plain = api.priceInsightHtml(FLIGHTS, true, {});
  assert.match(plain, /Fares on this list run from <strong>₹10,357<\/strong> to <strong>₹12,900<\/strong>\./);
  assert.doesNotMatch(plain, /currently (low|high)|typical/i);

  const rated = api.priceInsightHtml(FLIGHTS, true, { priceInsights: { priceLevel: 'high', typicalPriceRange: [8000, 11000], lowestPrice: 10357 } });
  assert.match(rated, /Google Flights rates prices for this search as <strong>high<\/strong> — usually <strong>₹8,000<\/strong> to <strong>₹11,000<\/strong>\. Cheapest here: <strong>₹10,357<\/strong>\./);
});

test('flights: the summary says when fares cover several travellers, and when some had no fare', () => {
  const html = load().priceInsightHtml(FLIGHTS, true, { adults: 2, children: 1, unpricedCount: 2 });
  assert.match(html, /\(total for 3 travellers\)\./);
  assert.match(html, /2 itineraries without a listed fare are not shown\./);
});

test('flights: an answer not marked live is "Unverified", never "Live" or demo', () => {
  const html = load().priceInsightHtml(FLIGHTS, false);
  assert.match(html, /data-status-unverified[^>]*>Unverified</);
  assert.doesNotMatch(html, />Live</);
  assert.doesNotMatch(html, /demo/i);
});

test('flights: the search trusts only meta.source "live"', () => {
  assert.match(HTML, /priceInsightHtml\(results, flightSearchMeta\.source === 'live', flightSearchMeta\)/);
  assert.doesNotMatch(HTML, /priceInsightHtml\(results, true\)/);
});

test('flights: no bundled sample flights exist to stand in for a failed search', () => {
  assert.doesNotMatch(HTML, /flightRoutes/);
  const searchFlights = declaration(/async function searchFlights\(/);
  const onError = searchFlights.slice(searchFlights.indexOf('catch (err)'));
  assert.match(onError, /flightSearchResults = \[\];[\s\S]*showFlightErrorState\(fromCode, toCode, TM_OPENED_AS_FILE \? TM_FILE_REASON : err\.message\)/);
  assert.doesNotMatch(onError, /renderFlightResults/);
});

test('compare page: flight and bus prices are live only when the backend says "live"', () => {
  assert.match(HTML, /compareShortest\(results\), source: body\.meta && body\.meta\.source === 'live' \? 'live' : 'demo' \};\s*\} catch \(e\) \{[^}]*return \{ price: compareEstimateFare\('flights'/);
  assert.match(HTML, /results\.map\(b => b\.fare\)\), duration: compareShortest\(results\), source: body\.meta && body\.meta\.source === 'live' \? 'live' : 'demo' \}/);
});

// --- trains ------------------------------------------------------------------

test('trains: IRCTC-verified trains are counted and shown as such', () => {
  const api = load();
  const st = api.trainDataStatus([
    { verification: { status: 'verified', verifiedTrains: 2 }, cached: false },
    { verification: { status: 'none', verifiedTrains: 0 }, cached: false }
  ]);
  assert.deepEqual({ ...st }, { demo: false, liveTrains: 2, cachedTrains: 0, rateLimited: false, notSubscribed: false, budgetExhausted: false, disabled: false, failed: false, providerDown: false, cached: false, timetableFetchedAt: null });
  assert.match(api.trainDataStatusHtml(st), /data-status-live[^>]*>IRCTC-verified · 2</);
});

test('trains: an exhausted RapidAPI quota is shown, with the timetable label', () => {
  const api = load();
  const html = api.trainDataStatusHtml(api.trainDataStatus([{ verification: { status: 'rate_limited', verifiedTrains: 0 } }]));
  assert.match(html, /data-status-info[^>]*>Public timetable</);
  assert.match(html, />IRCTC check unavailable</);
  assert.match(html, /monthly request quota/);
  assert.doesNotMatch(html, />IRCTC-verified/, 'no "IRCTC-verified" chip');
});

test('trains: a key without a subscription is shown, with the timetable label', () => {
  const api = load();
  const html = api.trainDataStatusHtml(api.trainDataStatus([{ verification: { status: 'not_subscribed', verifiedTrains: 0 } }]));
  assert.match(html, /data-status-info[^>]*>Public timetable</);
  assert.match(html, />IRCTC check unavailable</);
  assert.match(html, /not subscribed to the Indian Railway IRCTC API/);
  assert.doesNotMatch(html, />IRCTC-verified/);
});

test('trains: the timetable chip says it is reference data, with its source and fetch time', () => {
  const api = load();
  const st = api.trainDataStatus([
    { verification: { status: 'none' }, timetable: { source: 'timetable', provider: 'erail.in public timetable', live: false, fetchedAt: '2026-10-20T10:35:00.000Z' } },
    { verification: { status: 'none' }, timetable: { source: 'timetable', provider: 'erail.in public timetable', live: false, fetchedAt: '2026-10-20T10:30:00.000Z' } }
  ]);
  assert.equal(st.timetableFetchedAt, '2026-10-20T10:30:00.000Z', 'the oldest fetch');
  const html = api.trainDataStatusHtml(st);
  assert.match(html, /title="Reference data, not live: the published Indian Railways timetable from erail\.in \(fetched [^)]+\)/);
  assert.doesNotMatch(html, /data-status-live/);
});

test('trains: cached only when every station pair came from cache', () => {
  const api = load();
  assert.equal(api.trainDataStatus([{ cached: true }, { cached: false }]).cached, false);
  const st = api.trainDataStatus([{ cached: true }, { cached: true }]);
  assert.equal(st.cached, true);
  assert.match(api.trainDataStatusHtml(st), />Cached</);
});

test('trains: no backend means "Demo data"', () => {
  assert.match(load().trainDataStatusHtml({ demo: true }), /data-status-demo[^>]*>Demo data</);
  assert.match(HTML, /lastTrainDataStatus = live \? trainDataStatus\(settled\.filter\(s => s\.ok\)\.map\(s => s\.meta\)\) : \{ demo: true \};/);
  assert.match(HTML, /trains on this route\$\{trainDataStatusHtml\(lastTrainDataStatus\)\}/);
});

// --- request timeouts --------------------------------------------------------

test('timeouts: every backend search has one', () => {
  const { SEARCH_TIMEOUT_MS } = load();
  assert.deepEqual({ ...SEARCH_TIMEOUT_MS }, { flights: 30000, trains: 45000, buses: 8000 });
  assert.match(HTML, /fetchWithTimeout\(`\$\{TM_API_BASE\}\/api\/flights\/search\?\$\{query\}`, SEARCH_TIMEOUT_MS\.flights, 'flight'\)/);
  assert.match(HTML, /fetchWithTimeout\(`\$\{TM_API_BASE\}\/api\/trains\/search\?\$\{query\}`, SEARCH_TIMEOUT_MS\.trains, 'train'\)/);
  assert.match(HTML, /fetchWithTimeout\(`\$\{TM_API_BASE\}\/api\/buses\/search\?\$\{query\}`, SEARCH_TIMEOUT_MS\.buses, 'bus'\)/);
});

test('timeouts: a timed-out request becomes a clear error message', async () => {
  const fetch = async (url, opts) => {
    assert.ok(opts && opts.signal, 'an abort signal is passed');
    const err = new Error('signal timed out'); err.name = 'TimeoutError'; throw err;
  };
  const api = load({ fetch });
  await assert.rejects(api.fetchWithTimeout('http://localhost:3000/api/flights/search', 30000, 'flight'),
    { message: 'The flight search took longer than 30 seconds. Please try again.' });
});

test('timeouts: other network errors pass through unchanged', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(load({ fetch }).fetchWithTimeout('http://x/', 1000, 'bus'), { name: 'TypeError', message: 'Failed to fetch' });
});

// --- buses -------------------------------------------------------------------

test('buses: the search asks /api/buses/search and labels the result demo data', async () => {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ results: [], meta: { source: 'simulated' } }) };
  };
  const inventory = [{ id: 'demo-1', fare: 650 }];
  const api = load({ fetch, busGenerateInventory: () => inventory });
  const body = await api.fetchLiveBuses('Bengaluru', 'Shivamogga', '2026-11-20');
  assert.equal(requests.length, 1);
  const url = new URL(requests[0]);
  assert.equal(url.origin + url.pathname, 'http://localhost:3000/api/buses/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), { from: 'Bengaluru', to: 'Shivamogga', date: '2026-11-20' });
  assert.deepEqual({ ...body.meta }, { source: 'demo', backend: 'simulated' });
  assert.equal(body.results, inventory, 'keeps the page\'s own demo inventory (seat maps, boarding times)');
});

test('buses: district suffixes are dropped from the city names sent', async () => {
  const requests = [];
  const fetch = async (url) => { requests.push(url); return { ok: true, json: async () => ({ meta: { source: 'simulated' } }) }; };
  await load({ fetch, busGenerateInventory: () => [] }).fetchLiveBuses('Rampur (Bareilly)', 'Shivamogga', '2026-11-20');
  assert.equal(new URL(requests[0]).searchParams.get('from'), 'Rampur');
});

test('buses: an unreachable backend still gives demo data, marked offline', async () => {
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  const body = await load({ fetch, busGenerateInventory: () => [] }).fetchLiveBuses('Bengaluru', 'Shivamogga', '2026-11-20');
  assert.deepEqual({ ...body.meta }, { source: 'demo', backend: 'offline' });
});

test('buses: the status chip says demo data and why', () => {
  const api = load();
  const simulated = api.busDataStatusHtml({ source: 'demo', backend: 'simulated' });
  assert.match(simulated, /data-status-demo[^>]*>Demo data</);
  assert.match(simulated, /No live bus inventory provider is connected/);
  assert.match(simulated, /not live inventory/);
  assert.match(api.busDataStatusHtml({ source: 'demo', backend: 'offline' }), /backend could not be reached/);
  assert.match(HTML, /buses on this route\$\{busDataStatusHtml\(busDataMeta\)\}/);
  assert.match(HTML, /busDataMeta = \(body && body\.meta\) \|\| null;/);
});

test('status chips escape their tooltip text', () => {
  const html = load().busDataStatusHtml({ source: 'demo', backend: '"><script>x</script>' });
  assert.doesNotMatch(html, /<script>/);
});

test('price insight: Google\'s price level is shown as text, never as markup', () => {
  const html = load().priceInsightHtml(FLIGHTS, true, { priceInsights: { priceLevel: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/);
});

// --- bus checkout: the demo end screen never reads as a real booking --------

test('buses: the demo checkout\'s last step claims no ticket, booking, payment or cover', () => {
  const context = vm.createContext({
    busCo: {
      ref: 'TMBDEMO123', email: 'rider@example.com', phone: '9876543210', assure: 'yes', protect: true, paidTotal: 1234,
      date: '2026-11-20', bp: { time: '21:00', name: 'Majestic' }, dp: { time: '05:30', name: 'Guindy' },
      pax: [{ name: 'Asha ', gender: 'F', age: '30' }], seats: [{ id: 'L4' }],
      b: { fromName: 'Bengaluru', toName: 'Chennai', operatorName: 'KSRTC', busType: 'AC Sleeper', plate: '' }
    },
    busEsc: (s) => String(s), formatTime12hr: (t) => t, busShortDate: () => '', busPointDate: () => null,
    busPrettyDate: () => '', busDurText: () => '', busRupee: (n) => `₹${n}`
  });
  vm.runInContext(`${declaration(/function busCoStep3\(/)}\nthis.api = { busCoStep3 };`, context);
  const html = context.api.busCoStep3();
  assert.match(html, /Demo checkout complete — no ticket issued/);
  assert.match(html, /Demo reference <strong>TMBDEMO123<\/strong> · this is not a booking/);
  assert.match(html, /Demo total \(not charged\)/);
  // The TravelMate Assured option was removed from the bus checkout: no claim of it at all
  assert.doesNotMatch(html, /TravelMate Assured/);
  assert.match(html, /Travel Protection Plan selected \(demo\) — no cover was bought/);
  for (const claim of [/Booking confirmed/i, /ticket sent/i, /Booking ID/, /Total paid/i, /rider@example\.com/, /9876543210/, /✓ TravelMate Assured/, /Plan added/]) {
    assert.doesNotMatch(html, claim);
  }
});

// --- flights: a failed search is reported as failed, never as "no results" ---

// The page's real searchFlights(), with the DOM and the backend call stubbed.
function loadFlightSearch(fetchLiveFlights, extra = {}) {
  const calls = [];
  const elements = { flightFrom: { value: 'BLR' }, flightTo: { value: 'DEL' }, flightDepartureDate: { value: '2026-11-22' } };
  const element = () => ({ value: '', innerHTML: '', style: {}, classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || (elements[id] = element()) },
    flightAirports: [],
    resetFlightSortTabs() {}, abRouteHead() {}, showFlightLoadingState() {}, resetFlightRangeFilters() {},
    priceInsightHtml: () => '', renderFlightResults: () => calls.push('results'), revealFlightFilters() {},
    showNoFlightsState: () => calls.push('no-flights'),
    showFlightErrorState: (from, to, message) => calls.push(`error: ${message}`),
    fetchLiveFlights,
    ...extra
  });
  vm.runInContext([
    /const TM_OPENED_AS_FILE = .+;/.exec(HTML)[0],
    /const TM_FILE_REASON = .+;/.exec(HTML)[0],
    "let flightSearchResults = [], flightSearchMeta = {}, flightFromLabel = '', flightToLabel = '';",
    /let flightSearchFailed = false;/.exec(HTML)[0],
    /let flightSearchToken = null;/.exec(HTML)[0],
    declaration(/async function searchFlights\(/),
    'this.api = { searchFlights, state: () => ({ failed: flightSearchFailed, count: flightSearchResults.length }), prices: () => flightSearchResults.map((f) => f.price) };'
  ].join('\n'), context);
  return { api: context.api, calls };
}

test('flights: a failed search is marked failed and explained — never left looking like "no flights"', async () => {
  // Opened as a file (the browser hides the 403 behind "Failed to fetch"), a provider error, a rate limit
  for (const failure of [new TypeError('Failed to fetch'), new Error('Live flight prices could not be retrieved right now.'), new Error('Too many flight searches from this device right now.')]) {
    const { api, calls } = loadFlightSearch(async () => { throw failure; });
    await api.searchFlights();
    assert.deepEqual({ ...api.state() }, { failed: true, count: 0 }, failure.message);
    assert.deepEqual(calls, [`error: ${failure.message}`], 'the reason is shown, not "no flights"');
  }
  const empty = loadFlightSearch(async () => ({ results: [], meta: { source: 'live' } }));
  await empty.api.searchFlights();
  assert.deepEqual({ ...empty.api.state() }, { failed: false, count: 0 }, 'a live answer with no flights is not a failure');
  assert.deepEqual(empty.calls, ['no-flights']);
  let fail = true;
  const retried = loadFlightSearch(async () => { if (fail) throw new Error('timeout'); return { results: [{ price: 5710 }], meta: { source: 'live' } }; });
  await retried.api.searchFlights();
  fail = false;
  await retried.api.searchFlights();
  assert.deepEqual({ ...retried.api.state() }, { failed: false, count: 1 }, 'a new search clears the failure');
});

// The page's real uniRenderSummary(), for the given cards keyed by mode:
// { status = 'done', count = 0, fares = [], fastest = null, demo = false }.
function renderSummary(cards, { flightsFailed = false, trainsFailed = false } = {}) {
  const summary = { innerHTML: '' };
  const card = (key, fallback) => (mode) => (key in cards[mode] ? cards[mode][key] : fallback);
  const status = Object.fromEntries(Object.entries(cards).map(([mode, c]) => [mode, c.status || 'done']));
  const context = vm.createContext({
    document: { getElementById: (id) => (id === 'uniSummary' ? summary : null) },
    uniEnabledModes: () => Object.keys(cards),
    uniModeFares: card('fares', []), uniModeFastest: card('fastest', null), uniModeCount: card('count', 0), uniModeDemo: card('demo', false)
  });
  vm.runInContext([
    /const UNI_ORDER = .+;/.exec(HTML)[0],
    /const UNI_LABEL = .+;/.exec(HTML)[0],
    /const escapeAttr = .+;/.exec(HTML)[0],
    declaration(/function dataStatusChip\(/),
    `const uniStatus = ${JSON.stringify(status)}; let uniTrip = 'domestic'; let flightSearchFailed = ${flightsFailed}, trainSearchFailed = ${trainsFailed};`,
    declaration(/function uniDurationText\(/),
    declaration(/function uniRenderSummary\(/),
    'uniRenderSummary();'
  ].join('\n'), context);
  return summary.innerHTML;
}

// The Flights card only.
function renderSummaryCard({ status, failed = false, count = 0, fares = [] }) {
  return renderSummary({ flights: { status, count, fares } }, { flightsFailed: failed });
}

// One mode's card out of the rendered summary.
const cardFor = (html, label) => html.split('</button>').find((c) => c.includes(label)) || '';

test('summary card: a failed flight search says "Search failed"; only a real empty answer says "No results"', () => {
  const failedCard = renderSummaryCard({ status: 'done', failed: true });
  assert.match(failedCard, /<span class="uni-sum-price">Search failed<\/span>/);
  assert.match(failedCard, /see the reason under Flights/);
  assert.doesNotMatch(failedCard, /No results/);
  assert.match(failedCard, /onclick="uniJump\('flights'\)"/, 'it still opens the Flights section, where the reason is shown');
  const emptyCard = renderSummaryCard({ status: 'done', failed: false });
  assert.match(emptyCard, /<span class="uni-sum-price">No results<\/span>/);
  assert.doesNotMatch(emptyCard, /Search failed/);
  const resultsCard = renderSummaryCard({ status: 'done', count: 13, fares: [5710, 6400] });
  assert.match(resultsCard, /from ₹5,710/);
  assert.match(resultsCard, /13 options/);
  assert.match(renderSummaryCard({ status: 'loading', failed: true }), /Searching…/, 'a search in progress is not shown as failed');
});

test('summary cards: demo buses and trains say "Demo data" and never get the Cheapest / Fastest badge', () => {
  const badge = /class="uni-sum-badge(?: fast)?">|uni-sum-card best|uni-sum-card fast/;
  // Opened as a file: sample buses and trains, and the flight search failed
  const asFile = renderSummary({
    buses: { count: 90, fares: [549], fastest: 645, demo: true },
    trains: { count: 2, fares: [395, 1010], fastest: 495, demo: true },
    flights: { count: 0 }
  }, { flightsFailed: true });
  for (const label of ['🚌 Buses', '🚂 Trains']) {
    assert.match(cardFor(asFile, label), /data-status-demo[^>]*>Demo data</, label);
  }
  assert.doesNotMatch(asFile, badge, 'sample fares are not ranked');

  // Served by the backend: sample buses cheaper and quicker than the real
  // trains and live flights still don't take their badges
  const served = renderSummary({
    buses: { count: 12, fares: [150], fastest: 60, demo: true },
    trains: { count: 10, fares: [220, 395], fastest: 495 },
    flights: { count: 19, fares: [5070], fastest: 65 }
  });
  const buses = cardFor(served, '🚌 Buses');
  assert.match(buses, />Demo data</);
  assert.match(buses, /from ₹150/, 'the demo fare is still shown');
  assert.doesNotMatch(buses, badge);
  assert.match(cardFor(served, '🚂 Trains'), /uni-sum-badge">Cheapest</);
  assert.match(cardFor(served, '✈️ Flights'), /uni-sum-badge fast">Fastest</);
  assert.doesNotMatch(cardFor(served, '🚂 Trains') + cardFor(served, '✈️ Flights'), /Demo data/);
});

test('summary cards: a failed train search says "Search failed", not "No results"', () => {
  const failed = renderSummary({ trains: { count: 0 } }, { trainsFailed: true });
  assert.match(failed, /<span class="uni-sum-price">Search failed<\/span>/);
  assert.match(failed, /see the reason under Trains/);
  assert.doesNotMatch(failed, /No results/);
  assert.match(renderSummary({ trains: { count: 0 } }), /<span class="uni-sum-price">No results<\/span>/, 'a real empty answer is still "No results"');
});

test('summary cards: buses not marked live and trains from the page\'s own list are demo; flights never are', () => {
  const demo = (vars, mode) => {
    const context = vm.createContext({});
    vm.runInContext(`${vars}\n${declaration(/function uniModeDemo\(/)}\nthis.result = uniModeDemo(${JSON.stringify(mode)});`, context);
    return context.result;
  };
  const vars = (bus, train) => `let busDataMeta = ${JSON.stringify(bus)}, lastTrainDataStatus = ${JSON.stringify(train)};`;
  assert.equal(demo(vars({ source: 'demo', backend: 'simulated' }, null), 'buses'), true);
  assert.equal(demo(vars({ source: 'demo', backend: 'offline' }, null), 'buses'), true);
  assert.equal(demo(vars({ source: 'live' }, null), 'buses'), false);
  assert.equal(demo(vars(null, null), 'buses'), false, 'not searched yet');
  assert.equal(demo(vars(null, { demo: true }), 'trains'), true);
  assert.equal(demo(vars(null, { demo: false, liveTrains: 0 }), 'trains'), false, 'timetable trains are labelled in their own section, not demo');
  assert.equal(demo(vars({ source: 'demo' }, { demo: true }), 'flights'), false);
});

// --- trains: a failed search is reported as failed, never as "no trains" ----

// The page's real searchTrains(), with the DOM and the backend call stubbed.
function loadTrainSearch(fetchLiveTrains, { extra = {}, trainRoutes = {}, from = 'SBC', to = 'PUNE' } = {}) {
  const calls = [];
  const elements = { trainFrom: { value: from, dataset: {} }, trainTo: { value: to, dataset: {} }, trainJourneyDate: { value: '2026-11-03' } };
  const element = () => ({ value: '', dataset: {}, innerHTML: '', classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || (elements[id] = element()) },
    trainCityName: (code) => code, trainCityStations: (code) => [code], trainLivePairs: (f, t) => [[f[0], t[0]]],
    getStationName: (code) => code, extractCodeFromStationLabel: (label) => label,
    toLiveTrainShape: (t) => ({ trainNumber: t.number, classes: t.classes, source: 'reference' }),
    abRouteHead() {}, showTrainLoadingState() {}, revealTrainFilters() {},
    renderTrainResultsFiltered: () => calls.push('results'),
    showNoTrainsState: () => calls.push('no-trains'),
    showTrainErrorState: (f, t, message) => calls.push(`error: ${message}`),
    fetchLiveTrains, trainRoutes,
    ...extra
  });
  vm.runInContext([
    /const TM_OPENED_AS_FILE = .+;/.exec(HTML)[0],
    /const TM_FILE_REASON = .+;/.exec(HTML)[0],
    'let lastTrainResults = [], trainSort = {}, lastTrainSearchMeta = null, lastTrainDataStatus = null;',
    /let trainSearchFailed = false;/.exec(HTML)[0],
    declaration(/function trainDataStatus\(/),
    declaration(/async function searchTrains\(/),
    'this.api = { searchTrains, state: () => ({ failed: trainSearchFailed, count: lastTrainResults.length, demo: !!(lastTrainDataStatus && lastTrainDataStatus.demo) }) };'
  ].join('\n'), context);
  return { api: context.api, calls };
}

test('trains: a failed search is marked failed and explained — opened as a file, it says to start the backend and reload', async () => {
  const reason = /The TravelMate backend isn't answering this page\. Start it \(npm start in travelmate-backend\), then reload this page\./;
  // A route with no bundled demo trains; the browser hides a refused or unanswered request behind "Failed to fetch"
  const asFile = loadTrainSearch(async () => { throw new TypeError('Failed to fetch'); }, { extra: { location: { protocol: 'file:' } } });
  await asFile.api.searchTrains();
  assert.deepEqual({ ...asFile.api.state() }, { failed: true, count: 0, demo: true });
  assert.equal(asFile.calls.length, 1);
  assert.match(asFile.calls[0], reason);
  assert.doesNotMatch(asFile.calls[0], /Failed to fetch/);

  const asHttp = loadTrainSearch(async () => { throw new Error('Too many train searches from this device right now.'); }, { extra: { location: { protocol: 'http:' } } });
  await asHttp.api.searchTrains();
  assert.deepEqual(asHttp.calls, ['error: Too many train searches from this device right now.'], 'over http the server\'s own reason is kept');
  assert.equal(asHttp.api.state().failed, true);

  // A source that failed is not "no trains" either
  const down = loadTrainSearch(async () => ({ results: [], meta: { dataStatus: 'provider_unavailable' } }));
  await down.api.searchTrains();
  assert.equal(down.api.state().failed, true);
  assert.match(down.calls[0], /^error: Train data is unavailable right now\./);

  // A real answer with no trains is not a failure, and a new search clears one
  let fail = true;
  const retried = loadTrainSearch(async () => { if (fail) throw new TypeError('Failed to fetch'); return { results: [], meta: {} }; });
  await retried.api.searchTrains();
  fail = false;
  await retried.api.searchTrains();
  assert.deepEqual({ ...retried.api.state() }, { failed: false, count: 0, demo: false });
  assert.deepEqual(retried.calls, ['error: Failed to fetch', 'no-trains']);
});

test('trains: opened as a file on a route with bundled trains, they are shown as demo data — not as a failure', async () => {
  const trainRoutes = { 'SBC->KCG': [{ number: '10001', name: 'Sample Express', classes: [{ cls: 'SL', fare: 395 }] }] };
  const { api, calls } = loadTrainSearch(async () => { throw new TypeError('Failed to fetch'); },
    { extra: { location: { protocol: 'file:' } }, trainRoutes, from: 'SBC', to: 'KCG' });
  await api.searchTrains();
  assert.deepEqual({ ...api.state() }, { failed: false, count: 1, demo: true });
  assert.deepEqual(calls, ['results']);
});

// --- opened as a file: every message says what to do ----------------------------

test('opened as a file: when the backend doesn\'t answer, flights, trains and buses say to start it and reload the page', async () => {
  const asFile = { location: { protocol: 'file:' } };
  const asHttp = { location: { protocol: 'http:' } };
  const reason = /The TravelMate backend isn't answering this page\. Start it \(npm start in travelmate-backend\), then reload this page\./;

  // The browser hides a refused or unanswered request behind a generic network error
  const flightsFile = loadFlightSearch(async () => { throw new TypeError('Failed to fetch'); }, asFile);
  await flightsFile.api.searchFlights();
  assert.equal(flightsFile.calls.length, 1);
  assert.match(flightsFile.calls[0], reason);
  assert.doesNotMatch(flightsFile.calls[0], /Failed to fetch/);
  const flightsHttp = loadFlightSearch(async () => { throw new Error('Live flight prices could not be retrieved right now.'); }, asHttp);
  await flightsHttp.api.searchFlights();
  assert.deepEqual(flightsHttp.calls, ['error: Live flight prices could not be retrieved right now.'], 'over http the server\'s own reason is kept');

  const file = load(asFile), http = load(asHttp);
  assert.match(file.trainDataStatusHtml({ demo: true }), reason);
  assert.match(file.trainDataStatusHtml({ demo: true }), /sample trains, not real search results/);
  assert.doesNotMatch(file.trainDataStatusHtml({ demo: true }), /could not be reached/);
  assert.match(http.trainDataStatusHtml({ demo: true }), /The TravelMate backend could not be reached\. These are sample trains/);
  assert.match(file.busDataStatusHtml({ source: 'demo', backend: 'offline' }), reason);
  assert.match(http.busDataStatusHtml({ source: 'demo', backend: 'offline' }), /The TravelMate backend could not be reached\./);
  // Simulated buses over http keep their own explanation either way
  assert.match(http.busDataStatusHtml({ source: 'demo', backend: 'simulated' }), /No live bus inventory provider is connected/);
});

// --- overlapping searches: the summary only ever shows the latest search -----

// A promise settled later by the test, standing in for a slow backend answer.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('flights: an older search\'s answer arriving after a newer search started is dropped', async () => {
  // Bengaluru → Hyderabad, then swapped to Hyderabad → Bengaluru before its answer came
  const older = [{ price: 1111 }, { price: 1211 }, { price: 1311 }, { price: 1411 }];
  const newer = [{ price: 7777 }, { price: 7877 }];

  // The older answer arrives last
  let answers = [deferred(), deferred()];
  let { api, calls } = loadFlightSearch(() => answers.shift().promise);
  let [first, second] = answers.slice();
  let a = api.searchFlights(), b = api.searchFlights();
  second.resolve({ results: newer, meta: { source: 'live' } }); await b;
  first.resolve({ results: older, meta: { source: 'live' } }); await a;
  assert.deepEqual([...api.prices()], [7777, 7877], 'the list and summary keep the newer search');
  assert.deepEqual(calls, ['results'], 'the older answer is not rendered');

  // The older answer arrives first, while the newer search is still waiting
  answers = [deferred(), deferred()];
  ({ api, calls } = loadFlightSearch(() => answers.shift().promise));
  [first, second] = answers.slice();
  a = api.searchFlights(); b = api.searchFlights();
  first.resolve({ results: older, meta: { source: 'live' } }); await a;
  assert.deepEqual([...api.prices()], [], 'nothing from the older search is shown while the newer one waits');
  assert.deepEqual(calls, []);
  second.resolve({ results: newer, meta: { source: 'live' } }); await b;
  assert.deepEqual([...api.prices()], [7777, 7877]);

  // An older search failing late doesn't turn the newer results into "Search failed"
  answers = [deferred(), deferred()];
  ({ api, calls } = loadFlightSearch(() => answers.shift().promise));
  [first, second] = answers.slice();
  a = api.searchFlights(); b = api.searchFlights();
  second.resolve({ results: newer, meta: { source: 'live' } }); await b;
  first.reject(new Error('Live flight prices could not be retrieved right now.')); await a;
  assert.deepEqual({ ...api.state() }, { failed: false, count: 2 });
  assert.deepEqual(calls, ['results']);
});

test('flights: a new search drops the previous route\'s fares at once — none are left while it loads or after it fails', async () => {
  const answers = [deferred(), deferred()];
  const { api, calls } = loadFlightSearch(() => answers.shift().promise);
  const [first, second] = answers.slice();
  // Bengaluru → Hyderabad: 4 flights
  const a = api.searchFlights();
  first.resolve({ results: [{ price: 1111 }, { price: 1211 }, { price: 1311 }, { price: 1411 }], meta: { source: 'live' } }); await a;
  assert.deepEqual({ ...api.state() }, { failed: false, count: 4 });

  // Hyderabad → Bengaluru starts: the Bengaluru → Hyderabad fares and count are gone straight away
  const b = api.searchFlights();
  assert.deepEqual([...api.prices()], [], 'no fares from the previous route while the new search loads');
  assert.deepEqual({ ...api.state() }, { failed: false, count: 0 });

  // ...and it fails: still none of them, and the failure is reported
  second.reject(new Error('Live flight prices could not be retrieved right now.')); await b;
  assert.deepEqual({ ...api.state() }, { failed: true, count: 0 });
  assert.deepEqual(calls, ['results', 'error: Live flight prices could not be retrieved right now.']);
});

// The page's real searchEntities(), with each mode's search stubbed.
function loadSearchEntities(searches) {
  const events = [];
  const element = () => ({ value: '', dataset: {}, scrollIntoView() {} });
  const elements = {};
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || (elements[id] = element()) },
    switchTab() {}, toIsoDate: () => '2026-11-10',
    uniMarkLoading: (mode) => events.push(`loading ${mode}`),
    uniMarkDone: (mode) => events.push(`done ${mode}`),
    searchFlights: () => searches.flights.shift().promise,
    searchTrains: () => searches.trains.shift().promise,
    searchBuses: () => searches.buses.shift().promise
  });
  vm.runInContext([
    /const uniLatestSearch = \{\};/.exec(HTML)[0],
    declaration(/async function searchEntities\(/),
    'this.searchEntities = searchEntities;'
  ].join('\n'), context);
  return { searchEntities: context.searchEntities, events };
}

test('summary: only the latest search of a mode marks it done — never a search it replaced', async () => {
  const BLR = { code: 'BLR', city: 'Bengaluru', name: 'Kempegowda International Airport' };
  const HYD = { code: 'HYD', city: 'Hyderabad', name: 'Rajiv Gandhi International Airport' };
  for (const mode of ['flights', 'trains', 'buses']) {
    const runs = [deferred(), deferred()];
    const { searchEntities, events } = loadSearchEntities({ flights: [], trains: [], buses: [], [mode]: runs.slice() });
    const older = searchEntities(mode, BLR, HYD, '2026-11-10', { quiet: true });
    const newer = searchEntities(mode, HYD, BLR, '2026-11-10', { quiet: true });
    runs[0].resolve();
    assert.deepEqual({ ...(await older) }, { ok: false, superseded: true }, mode);
    assert.deepEqual(events, [`loading ${mode}`, `loading ${mode}`], `${mode}: still "Searching…" while the newer search waits`);
    runs[1].resolve();
    assert.equal((await newer).ok, true);
    assert.deepEqual(events, [`loading ${mode}`, `loading ${mode}`, `done ${mode}`], `${mode}: marked done once, by the newer search`);
  }

  // Each mode is tracked on its own: a train search doesn't replace a flight search
  const flight = deferred(), train = deferred();
  const { searchEntities, events } = loadSearchEntities({ flights: [flight], trains: [train], buses: [] });
  const f = searchEntities('flights', BLR, HYD, '2026-11-10', { quiet: true });
  const t = searchEntities('trains', BLR, HYD, '2026-11-10', { quiet: true });
  flight.resolve(); train.resolve();
  await Promise.all([f, t]);
  assert.deepEqual(events, ['loading flights', 'loading trains', 'done flights', 'done trains']);
});

// --- opened as a file: the page calls the backend itself, with the local key ---

// The page's fetch, after its key step runs with the page opened over
// `protocol` and travelmate-local-key.js giving it `key` (or nothing).
function fileFetch(protocol, key) {
  const sent = [];
  const window = { fetch: (url, init) => { sent.push({ url, init }); return Promise.resolve('answer'); } };
  if (key !== undefined) window.TM_LOCAL_KEY = key;
  const original = window.fetch;
  vm.runInContext([
    /const TM_API_BASE = .+;/.exec(HTML)[0],
    /const TM_OPENED_AS_FILE = .+;/.exec(HTML)[0],
    declaration(/if \(TM_OPENED_AS_FILE && typeof window/)
  ].join('\n'), vm.createContext({ window, location: { protocol } }));
  return { fetch: window.fetch, sent, wrapped: window.fetch !== original };
}

test('opened as a file: the page loads the local key in <head> and sends it with every API call to http://localhost:3000 — no banners, no redirect', async () => {
  assert.ok(HTML.indexOf('<script src="travelmate-local-key.js"></script>') > 0, 'the key file is loaded');
  assert.ok(HTML.indexOf('<script src="travelmate-local-key.js"></script>') < HTML.indexOf('<style>'), 'in <head>, before any API call can be made');

  const key = 'a'.repeat(64);
  const asFile = fileFetch('file:', key);
  const signal = AbortSignal.timeout(1000);
  assert.equal(await asFile.fetch('http://localhost:3000/api/trains/search?from=SBC', { signal }), 'answer');
  assert.deepEqual(asFile.sent[0].url, 'http://localhost:3000/api/trains/search?from=SBC');
  assert.equal(asFile.sent[0].init.signal, signal, 'the caller\'s timeout is kept');
  assert.deepEqual({ ...asFile.sent[0].init.headers }, { 'X-TravelMate-Key': key });
  await asFile.fetch('http://localhost:3000/api/locations/search?q=Bengaluru');
  assert.deepEqual({ ...asFile.sent[1].init.headers }, { 'X-TravelMate-Key': key }, 'a call without options gets the key too');
  await asFile.fetch('https://www.google.com/flights', {});
  assert.deepEqual(asFile.sent[2].init, {}, 'nothing but the TravelMate API ever gets the key');

  assert.equal(fileFetch('http:', key).wrapped, false, 'served by the backend, fetch is left alone');
  assert.equal(fileFetch('file:').wrapped, false, 'without a key file (backend never started), fetch is left alone');

  for (const removed of ['tm-file-notice', 'tm-file-results-notice', 'Live searches are unavailable', 'Open live TravelMate']) {
    assert.ok(!HTML.includes(removed), `no file:// banner or detour left ("${removed}")`);
  }
});

// A failed search's message, from the page's real showFlightErrorState() /
// showTrainErrorState(), with the page opened over `protocol`.
function renderFailure(fn, protocol) {
  const list = { innerHTML: '' };
  const context = vm.createContext({
    location: { protocol },
    document: { getElementById: (id) => (/ResultsList$/.test(id) ? list : { style: {} }) },
    abResultsState() {}, getAirportLabel: (code) => code, getStationName: (code) => code
  });
  vm.runInContext([
    /const TM_OPENED_AS_FILE = .+;/.exec(HTML)[0],
    declaration(/function tmRetryHtml\(/),
    declaration(new RegExp(`function ${fn}\\(`)),
    `${fn}('BLR', 'HYD', 'The reason.');`
  ].join('\n'), context);
  return list.innerHTML;
}

test('a failed flight or train search offers Retry Search — opened as a file too, since that page reaches the backend itself', () => {
  for (const [fn, retry] of [['showFlightErrorState', 'searchFlights()'], ['showTrainErrorState', 'searchTrains()']]) {
    for (const protocol of ['file:', 'http:']) {
      const shown = renderFailure(fn, protocol);
      assert.match(shown, /The reason\./, `${fn} (${protocol}): the reason is shown`);
      assert.match(shown, new RegExp(`<button type="button" class="select-flight-btn" onclick="${retry.replace(/[()]/g, '\\$&')}">Retry Search</button>`), `${fn} (${protocol})`);
    }
  }
});

// --- served by the backend: an ordinary page ----------------------------------

test('TravelMate.html is an ordinary page, served or opened as a file: no file:// frame, redirect, check-again or "Opening TravelMate..." screen; only Book Now opens a tab', () => {
  for (const removed of ['tm-live-frame', 'travelmate:ready', 'tm-file-connecting', 'tm-file-opening', 'tm-file-live', 'Opening TravelMate', 'visibilitychange', 'Start TravelMate']) {
    assert.ok(!HTML.includes(removed), `nothing left of "${removed}"`);
  }
  assert.doesNotMatch(HTML, /createElement\(['"]iframe['"]\)/, 'no frame is created');
  assert.doesNotMatch(HTML, /(^|[^.\w])location\.(replace|assign|reload)\(|(^|[^.\w])location\.href\s*=[^=]/m, 'the page never navigates itself');
  const opens = (src) => (src.match(/window\.open\(/g) || []).length;
  assert.ok(opens(HTML) > 0);
  assert.equal(opens(declaration(/async function flightBookNow\(/)), opens(HTML), 'tabs are opened only by Book Now (the airline\'s booking page)');
});
