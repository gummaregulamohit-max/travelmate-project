// IRCTC quota safety, offline: axios.get is stubbed (erail / IRCTC-shaped
// answers) and request counts go to a throwaway usage file, so no RapidAPI
// request is ever sent and the real key is never used.
//   - one request per train at a time (cache + in-flight sharing)
//   - TRAIN_API_REQUEST_BUDGET (off by default) and the per-search limit
//   - no retries: empty answers, 403, 429, network errors
//   - 403 / 429 / "0 remaining" blocks that survive a restart
//   - cache metadata: when IRCTC answered vs. when it was served again
//   - search / schedule labels: live, cached, timetable, no results, unavailable

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const USAGE_FILE = path.join(os.tmpdir(), `travelmate-irctc-quota-test-${process.pid}.json`);
process.env.RAPIDAPI_KEY = 'fake-rapidapi-key-for-quota-tests';
process.env.TRAIN_API_USAGE_FILE = USAGE_FILE;
delete process.env.TRAIN_API_REQUEST_BUDGET;
delete process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH;
const irctc = require(path.join(ROOT, 'src/services/irctc.service'));
const { REASON_MESSAGES } = irctc;

const realGet = axios.get;
let calls;
let respond;
beforeEach((t) => {
  calls = [];
  axios.get = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
  process.env.TRAIN_API_REQUEST_BUDGET = '1000';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
});
afterEach(() => {
  axios.get = realGet;
  fs.rmSync(USAGE_FILE, { force: true });
  irctc.resetStateForTests();
});

const irctcCalls = () => calls.filter((c) => c.url.includes('rapidapi.com'));
const savedUsage = () => JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
// Forget everything in memory, as a server restart would; the usage file stays.
const restart = () => irctc.resetStateForTests();

function stop(code, name, arr, dep, day) {
  return { stationCode: code, stationName: name, arrivalTime: arr, departureTime: dep, routeNumber: '1', haltTime: '--', distance: '0', dayCount: String(day) };
}

function irctcTrain(trainNumber, headers = {}) {
  return {
    status: 200,
    headers,
    data: { body: [{ trains: [{
      trainNumber, trainName: 'Sampark Kranti', stationFrom: 'YPR', stationTo: 'NZM', runningOn: 'YYYYYYY',
      schedule: [stop('YPR', 'Yesvantpur Jn', '--', '15:00', 1), stop('NZM', 'H Nizamuddin', '11:40', '--', 3)]
    }] }] }
  };
}

const emptyAnswer = () => ({ status: 200, headers: {}, data: { body: [{ trains: [] }] } });

function httpError(status, message, headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, headers, data: { message } };
  throw err;
}

function erailRecord(trainNumber) {
  const f = Array(30).fill('');
  Object.assign(f, { 0: trainNumber, 1: 'SAMPARK KRANTI', 7: 'YPR', 9: 'NZM', 10: '15.00', 12: '44.40', 13: '1111111', 21: '01100' });
  f.push('DATASOURCE_IR', '', '', 'EXP:2380:0,0:1500,0:1100,0');
  return f.join('~');
}

// erail.in: the route listing (Station_From), a train-number lookup (TrainNo)
// and its stops (Action=TRAINROUTE).
function erail(trainNumbers, { schedule = false } = {}) {
  return (url, opts) => {
    const p = (opts && opts.params) || {};
    if (p.TrainNo) {
      if (!schedule) return { data: '' };
      const f = Array(20).fill('');
      Object.assign(f, { 0: p.TrainNo, 1: 'SAMPARK KRANTI', 2: 'Yesvantpur', 3: 'YPR', 4: 'Nizamuddin', 5: 'NZM', 14: '4321', 17: 'DATASOURCE_IR' });
      return { data: `hdr^${f.join('~')}` };
    }
    if (p.Action === 'TRAINROUTE') return { data: 'hdr^1~YPR~Yesvantpur~First~15.00~0~0~1^2~NZM~Nizamuddin~11.40~Last~0~2380~3' };
    return { data: ['header', ...trainNumbers.map(erailRecord)].join('^') };
  };
}

function routeTo(irctcAnswer, erailAnswer) {
  return (url, opts) => (url.includes('erail.in') ? erailAnswer(url, opts) : irctcAnswer(url, opts));
}

async function withApp(fn) {
  const app = express();
  app.use('/api/trains', require(path.join(ROOT, 'src/routes/trains.routes')));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const get = async (q) => {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/trains${q}`);
    return { status: res.status, body: await res.json() };
  };
  try { return await fn(get); } finally { srv.close(); }
}

// --- deduplication -----------------------------------------------------------

test('concurrent lookups of one train share a single request', async () => {
  respond = async (url) => { await new Promise((r) => setTimeout(r, 20)); return irctcTrain(url.split('/').pop()); };
  const results = await Promise.all(Array.from({ length: 5 }, () => irctc.lookupTrain('12001')));
  assert.equal(irctcCalls().length, 1);
  assert.equal(results.filter((r) => r.requested).length, 1, 'one caller sent it, the rest joined');
  assert.ok(results.every((r) => r.details.trainNumber === '12001' && r.cached === false));
  assert.equal(savedUsage().requestsSent, 1, 'counted once');
});

test('a repeat lookup is served from cache without a request', async () => {
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('12002');
  const again = await irctc.lookupTrain('12002');
  assert.equal(irctcCalls().length, 1);
  assert.equal(again.cached, true);
});

test('a failed in-flight request is shared too, not repeated', async () => {
  respond = async () => { await new Promise((r) => setTimeout(r, 20)); return httpError(500, 'upstream'); };
  const settled = await Promise.allSettled([irctc.lookupTrain('12003'), irctc.lookupTrain('12003'), irctc.lookupTrain('12003')]);
  assert.ok(settled.every((s) => s.status === 'rejected' && s.reason.reason === 'failed'));
  assert.equal(irctcCalls().length, 1);
});

test('concurrent route searches share their lookups of the same trains', async () => {
  respond = routeTo(async (url) => { await new Promise((r) => setTimeout(r, 20)); return irctcTrain(url.split('/').pop()); }, erail(['12011', '12012', '12013']));
  await withApp(async (get) => {
    await Promise.all([
      get('/search?from=YPR&to=NZM&date=2026-12-01'),
      get('/search?from=YPR&to=NZM&date=2026-12-02'),
      get('/search?from=YPR&to=NZM&date=2026-12-03')
    ]);
  });
  assert.equal(irctcCalls().length, 3, 'one request per distinct train, not per search');
});

// --- budget and per-search limit ---------------------------------------------

test('live requests are off by default: no request, reason "disabled"', async () => {
  delete process.env.TRAIN_API_REQUEST_BUDGET;
  respond = () => assert.fail('no request may be sent');
  await assert.rejects(irctc.lookupTrain('12021'), { reason: 'disabled' });
  process.env.TRAIN_API_REQUEST_BUDGET = '0';
  await assert.rejects(irctc.lookupTrain('12021'), { reason: 'disabled' });
  assert.equal(irctc.requestBudgetStatus().enabled, false);
  assert.ok(!fs.existsSync(USAGE_FILE), 'nothing counted');
});

test('the global budget is enforced, persisted, and not reset by a restart', async () => {
  process.env.TRAIN_API_REQUEST_BUDGET = '2';
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('12031');
  await irctc.lookupTrain('12032');
  await assert.rejects(irctc.lookupTrain('12033'), { reason: 'budget_exhausted' });
  assert.equal(irctcCalls().length, 2);
  assert.equal(savedUsage().requestsSent, 2);

  restart();
  await assert.rejects(irctc.lookupTrain('12034'), { reason: 'budget_exhausted' });
  assert.equal(irctcCalls().length, 2, 'still exhausted after a restart');

  process.env.TRAIN_API_REQUEST_BUDGET = '3';
  await irctc.lookupTrain('12034');
  assert.equal(savedUsage().requestsSent, 3, 'raising the budget allows more; the count carries on');
});

test('a usage file that cannot be read keeps requests off instead of restarting the count', async () => {
  fs.writeFileSync(USAGE_FILE, '{ not json');
  respond = () => assert.fail('no request may be sent');
  await assert.rejects(irctc.lookupTrain('12041'), { reason: 'disabled' });
  assert.equal(fs.readFileSync(USAGE_FILE, 'utf8'), '{ not json', 'left as it was');
});

test('a route search sends at most the per-search limit (3) of new requests', async () => {
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail(['12051', '12052', '12053', '12054', '12055']));
  const { trains } = await irctc.searchLiveTrains({ fromCode: 'YPR', toCode: 'NZM', date: '2026-12-04' });
  assert.equal(irctcCalls().length, 3);
  assert.deepEqual(trains.map((t) => t.source), ['live-schedule', 'live-schedule', 'live-schedule', 'schedule', 'schedule']);
});

test('verify=0 and a budget of 0 send no request, and cached IRCTC data is still used', async () => {
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail(['12061', '12062']));
  await irctc.lookupTrain('12061');
  assert.equal(irctcCalls().length, 1);
  await withApp(async (get) => {
    const { body } = await get('/search?from=YPR&to=NZM&date=2026-12-05&verify=0');
    assert.deepEqual(body.results.map((t) => t.source), ['cached-schedule', 'schedule']);
    assert.equal(body.meta.dataStatus, 'cached_verified');
    process.env.TRAIN_API_REQUEST_BUDGET = '0';
    const off = await get('/search?from=YPR&to=NZM&date=2026-12-06');
    assert.equal(off.body.meta.verification.status, 'disabled');
    assert.equal(off.body.meta.verification.message, REASON_MESSAGES.disabled);
  });
  assert.equal(irctcCalls().length, 1, 'no new request');
});

// --- no retries --------------------------------------------------------------

for (const [name, answer, reason] of [
  ['an empty answer', emptyAnswer, null],
  ['a 403', () => httpError(403, 'You are not subscribed to this API.'), 'not_subscribed'],
  ['a 429', () => httpError(429, 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.'), 'rate_limited'],
  ['a network error', () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }, 'failed']
]) {
  test(`${name} is not retried`, async () => {
    respond = answer;
    if (reason) await assert.rejects(irctc.lookupTrain('12071'), { reason });
    else assert.equal((await irctc.lookupTrain('12071')).details, null);
    assert.equal(irctcCalls().length, 1);
  });
}

// --- 403 / 429 / quota-exceeded blocks -----------------------------------------

test('a 403 blocks all requests, and the block survives a restart', async () => {
  respond = () => httpError(403, 'You are not subscribed to this API.');
  await assert.rejects(irctc.lookupTrain('12081'), { reason: 'not_subscribed' });
  restart();
  respond = () => assert.fail('no request while blocked');
  await assert.rejects(irctc.lookupTrain('12082'), (err) => {
    assert.equal(err.reason, 'not_subscribed');
    assert.equal(err.publicMessage, REASON_MESSAGES.not_subscribed);
    return true;
  });
  assert.equal(savedUsage().block.reason, 'not_subscribed');
});

test('a 429 blocks until RapidAPI\'s reset time, also after a restart', async (t) => {
  respond = () => httpError(429, 'You have exceeded the MONTHLY quota', { 'x-ratelimit-requests-reset': '7200' });
  await assert.rejects(irctc.lookupTrain('12091'), { reason: 'rate_limited' });
  restart();
  await assert.rejects(irctc.lookupTrain('12092'), { reason: 'rate_limited' });
  assert.equal(irctcCalls().length, 1);

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 7201 * 1000);
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('12092');
  assert.equal(irctcCalls().length, 2, 'resumes after the reset time');
});

test('RapidAPI reporting 0 requests left stops further requests until its reset', async () => {
  respond = (url) => irctcTrain(url.split('/').pop(), { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-limit': '50', 'x-ratelimit-requests-reset': '86400' });
  await irctc.lookupTrain('12101');
  assert.deepEqual({ remaining: savedUsage().provider.remaining, limit: savedUsage().provider.limit }, { remaining: 0, limit: 50 });
  await assert.rejects(irctc.lookupTrain('12102'), { reason: 'rate_limited' });
  assert.equal(irctcCalls().length, 1);
});

// --- cache metadata ------------------------------------------------------------

test('cache metadata keeps when IRCTC answered, separate from being served again', async (t) => {
  respond = (url) => irctcTrain(url.split('/').pop());
  const first = await irctc.lookupTrain('12111');
  assert.equal(first.cached, false);
  assert.ok(Date.parse(first.respondedAt));

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 3 * 24 * 60 * 60 * 1000);
  const later = await irctc.lookupTrain('12111');
  assert.equal(later.cached, true);
  assert.equal(later.respondedAt, first.respondedAt, 'still the original answer time');
  assert.ok(Date.parse(later.cachedAt));
  assert.equal(irctcCalls().length, 1);
});

test('the schedule pop-up labels IRCTC data live once, then cached — and reopening costs nothing', async () => {
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail([]));
  await withApp(async (get) => {
    const first = await get('/schedule?train=12121');
    assert.equal(first.body.meta.status, 'live');
    assert.equal(first.body.meta.live, true);
    const again = await get('/schedule?train=12121');
    assert.equal(again.body.meta.status, 'cached');
    assert.equal(again.body.meta.live, false);
    assert.equal(again.body.meta.cached, true);
    assert.equal(again.body.meta.respondedAt, first.body.meta.respondedAt);
  });
  assert.equal(irctcCalls().length, 1);
});

test('a pop-up for a train a search already verified sends no request', async () => {
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail(['12131']));
  await withApp(async (get) => {
    await get('/search?from=YPR&to=NZM&date=2026-12-07');
    const { body } = await get('/schedule?train=12131');
    assert.equal(body.meta.source, 'irctc');
    assert.equal(body.meta.status, 'cached');
  });
  assert.equal(irctcCalls().length, 1);
});

test('with live requests off, the pop-up uses the timetable and says why', async () => {
  process.env.TRAIN_API_REQUEST_BUDGET = '0';
  respond = routeTo(() => assert.fail('no IRCTC request'), erail([], { schedule: true }));
  await withApp(async (get) => {
    const { status, body } = await get('/schedule?train=12141');
    assert.equal(status, 200);
    assert.equal(body.meta.source, 'timetable');
    assert.equal(body.meta.live, false);
    assert.deepEqual(body.meta.verification, { provider: 'Indian Railway IRCTC (RapidAPI)', status: 'disabled', message: REASON_MESSAGES.disabled });
  });
});

// --- provider unavailable vs. no results; sanitized errors ----------------------

test('no trains because sources failed is "provider_unavailable", not "no results"', async () => {
  respond = routeTo(() => httpError(403, 'You are not subscribed to this API.'), () => { throw new Error('erail down'); });
  await withApp(async (get) => {
    const { status, body } = await get('/search?from=JTJ&to=GTL&date=2026-12-08');
    assert.equal(status, 200);
    assert.deepEqual(body.results, []);
    assert.equal(body.meta.dataStatus, 'provider_unavailable');
    assert.equal(body.meta.source, 'unavailable');
  });
});

test('a route with no trains in any source is "no_results"', async () => {
  respond = routeTo(() => assert.fail('no candidates, no lookup'), erail([]));
  await withApp(async (get) => {
    const { body } = await get('/search?from=JTJ&to=GTL&date=2026-12-09');
    assert.equal(body.meta.dataStatus, 'no_results');
  });
});

test('a schedule that no source could provide is a 503, never "no such train"', async () => {
  respond = routeTo(() => httpError(429, 'quota'), () => { throw new Error('erail down'); });
  await withApp(async (get) => {
    const { status, body } = await get('/schedule?train=12151');
    assert.equal(status, 503);
    assert.equal(body.error.reason, 'provider_unavailable');
    assert.match(body.error.message, /does not mean the train doesn't exist/);
  });
});

test('403 / 429 reach the response as fixed messages — no provider text, no key', async () => {
  for (const [status, reason] of [[403, 'not_subscribed'], [429, 'rate_limited']]) {
    fs.rmSync(USAGE_FILE, { force: true });
    irctc.resetStateForTests();
    respond = routeTo(() => httpError(status, `RAW PROVIDER TEXT ${status}`), erail(['12161']));
    await withApp(async (get) => {
      const { body } = await get(`/search?from=YPR&to=NZM&date=2026-12-1${status === 403 ? 0 : 1}`);
      assert.equal(body.meta.verification.status, reason);
      assert.equal(body.meta.verification.message, REASON_MESSAGES[reason]);
      assert.equal(body.results[0].source, 'schedule', 'the train is still listed');
      const text = JSON.stringify(body);
      assert.ok(!text.includes('RAW PROVIDER TEXT'));
      assert.ok(!text.includes(process.env.RAPIDAPI_KEY));
    });
  }
  assert.ok(!fs.readFileSync(USAGE_FILE, 'utf8').includes(process.env.RAPIDAPI_KEY), 'the key is not in the usage file');
});

// --- frontend: which calls may spend IRCTC requests ------------------------------

test('TravelMate only lets the searched station pair verify; other pairs and Compare are cache-only', () => {
  const html = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');
  assert.match(html, /trainLivePairs\(fromCodes, toCodes\)\.map\(async \(\[f, t\], i\) => \{[\s\S]{0,120}fetchLiveTrains\(f, t, \{ verify: i === 0 \}\)/);
  assert.match(html, /fetchLiveTrains\(pair\.from\.code, pair\.to\.code, \{ verify: false \}\)/);
  assert.match(html, /if \(!verify\) params\.verify = '0';/);
  assert.equal((html.match(/fetchLiveTrains\(/g) || []).length, 3, 'definition + two callers, nothing else');
  assert.equal((html.match(/fetch\(`http:\/\/localhost:3000\/api\/trains\/schedule\?/g) || []).length, 1, 'only the pop-up asks for a schedule');
});
