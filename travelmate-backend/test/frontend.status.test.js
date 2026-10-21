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
    /const escapeAttr = .+;/.exec(HTML)[0],
    /const busShortName = .+;/.exec(HTML)[0],
    declaration(/function dataStatusChip\(/),
    declaration(/const SEARCH_TIMEOUT_MS = \{/),
    declaration(/async function fetchWithTimeout\(/),
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

test('flights: a live answer shows "Live", not demo', () => {
  const html = load().priceInsightHtml(FLIGHTS, true);
  assert.match(html, /data-status-live[^>]*>Live</);
  assert.doesNotMatch(html, /demo/i);
  assert.doesNotMatch(html, /Cached/);
});

test('flights: a cached live answer also shows "Cached"', () => {
  const html = load().priceInsightHtml(FLIGHTS, true, { cached: true });
  assert.match(html, />Live</);
  assert.match(html, /data-status-cached[^>]*>Cached</);
});

test('flights: mock or bundled flights show "Demo data", never "Live"', () => {
  const html = load().priceInsightHtml(FLIGHTS, false);
  assert.match(html, /showing demo data — live prices unavailable/);
  assert.match(html, /data-status-demo[^>]*>Demo data</);
  assert.doesNotMatch(html, />Live</);
});

test('flights: the search trusts only meta.source "live" (mock flights are demo)', () => {
  assert.match(HTML, /priceInsightHtml\(results, meta\.source === 'live', \{ cached: meta\.cached === true \}\)/);
  assert.doesNotMatch(HTML, /priceInsightHtml\(results, true\)/);
});

test('compare page: flight and bus prices are live only when the backend says "live"', () => {
  assert.match(HTML, /compareShortest\(results\), source: body\.meta && body\.meta\.source === 'live' \? 'live' : 'demo' \};\s*\} catch \(e\) \{\s*const demo = flightRoutes/);
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
  assert.match(HTML, /fetchWithTimeout\(`http:\/\/localhost:3000\/api\/flights\/search\?\$\{query\}`, SEARCH_TIMEOUT_MS\.flights, 'flight'\)/);
  assert.match(HTML, /fetchWithTimeout\(`http:\/\/localhost:3000\/api\/trains\/search\?\$\{query\}`, SEARCH_TIMEOUT_MS\.trains, 'train'\)/);
  assert.match(HTML, /fetchWithTimeout\(`http:\/\/localhost:3000\/api\/buses\/search\?\$\{query\}`, SEARCH_TIMEOUT_MS\.buses, 'bus'\)/);
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
