// Known-route labels, schedule pop-up requests, budget exhaustion, the manual
// budget reset and cache behaviour — offline: axios.get is stubbed, request
// counts go to a throwaway usage file, and no RapidAPI request is ever sent.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const axios = require('axios');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');
const USAGE_FILE = path.join(os.tmpdir(), `travelmate-irctc-budget-test-${process.pid}.json`);
process.env.RAPIDAPI_KEY = 'fake-rapidapi-key-for-budget-tests';
process.env.TRAIN_API_USAGE_FILE = USAGE_FILE;
delete process.env.TRAIN_API_REQUEST_BUDGET;
delete process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH;
const irctc = require(path.join(ROOT, 'src/services/irctc.service'));

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
const noIrctc = () => assert.fail('no IRCTC request may be sent');

function irctcTrain(trainNumber, headers = {}) {
  const stop = (code, name, arr, dep, day) => ({ stationCode: code, stationName: name, arrivalTime: arr, departureTime: dep, routeNumber: '1', haltTime: '--', distance: '0', dayCount: String(day) });
  return {
    status: 200, headers,
    data: { body: [{ trains: [{ trainNumber, trainName: 'Sampark Kranti', stationFrom: 'YPR', stationTo: 'NZM', runningOn: 'YYYYYYY',
      schedule: [stop('YPR', 'Yesvantpur Jn', '--', '15:00', 1), stop('NZM', 'H Nizamuddin', '11:40', '--', 3)] }] }] }
  };
}
const slowTrain = async (url) => { await new Promise((r) => setTimeout(r, 20)); return irctcTrain(url.split('/').pop()); };

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

// erail.in answers: a route listing, a train lookup and its stops.
function erail(trainNumbers) {
  return (url, opts) => {
    const p = (opts && opts.params) || {};
    if (p.TrainNo) {
      const f = Array(20).fill('');
      Object.assign(f, { 0: p.TrainNo, 1: 'SAMPARK KRANTI', 2: 'Yesvantpur', 3: 'YPR', 4: 'Nizamuddin', 5: 'NZM', 14: '4321', 17: 'DATASOURCE_IR' });
      return { data: `hdr^${f.join('~')}` };
    }
    if (p.Action === 'TRAINROUTE') return { data: 'hdr^1~YPR~Yesvantpur~First~15.00~0~0~1^2~NZM~Nizamuddin~11.40~Last~0~2380~3' };
    return { data: ['header', ...trainNumbers.map(erailRecord)].join('^') };
  };
}
const routeTo = (irctcAnswer, erailAnswer) => (url, opts) => (url.includes('erail.in') ? erailAnswer(url, opts) : irctcAnswer(url, opts));

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

// One top-level function from TravelMate.html, run on its own.
function pageFunction(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) {
      const context = vm.createContext({});
      vm.runInContext(`${HTML.slice(start, i + 1)}; this.fn = ${name};`, context);
      return context.fn;
    }
  }
  throw new Error(`unterminated ${name}`);
}

// --- known routes are reference data -------------------------------------------

test('known-route trains are labelled "reference", never verified or live', async () => {
  // erail down and IRCTC off: the known YPR->KCG route answers
  process.env.TRAIN_API_REQUEST_BUDGET = '0';
  respond = routeTo(noIrctc, () => { throw new Error('erail down'); });
  await withApp(async (get) => {
    const { body } = await get('/search?from=YPR&to=KCG&date=2026-10-30');
    assert.ok(body.results.length > 0);
    assert.equal(body.meta.source, 'reference');
    assert.equal(body.meta.dataStatus, 'timetable');
    for (const t of body.results) {
      assert.equal(t.source, 'reference', t.trainNumber);
      assert.ok(!('verifiedAt' in t));
    }
    assert.equal(body.meta.verification.liveTrains, 0);
    assert.equal(body.meta.verification.cachedTrains, 0);
  });
});

test('TravelMate shows known-route and bundled trains as a reference timetable', () => {
  const tag = pageFunction('trainSourceTag');
  for (const source of ['reference', 'verified']) {
    const html = tag(source);
    assert.match(html, /Reference timetable/);
    assert.doesNotMatch(html, /Verified|verified|Live|live-tag|🟢/, source);
  }
  assert.doesNotMatch(HTML, /Verified timings/);
  assert.match(HTML, /source: 'reference' \/\/ a static timetable/, 'the offline table is reference data too');
  assert.match(tag('live-schedule'), /IRCTC-verified timings/, 'only IRCTC answers say verified');
});

// --- schedule pop-ups -------------------------------------------------------------

test('concurrent pop-ups for one train send one request', async () => {
  respond = routeTo(slowTrain, erail([]));
  await withApp(async (get) => {
    const answers = await Promise.all([get('/schedule?train=13001'), get('/schedule?train=13001'), get('/schedule?train=13001')]);
    assert.ok(answers.every((a) => a.status === 200 && a.body.meta.source === 'irctc'));
  });
  assert.equal(irctcCalls().length, 1);
  assert.equal(savedUsage().requestsSent, 1);
});

test('a pop-up opened while a search is looking up the same train shares that request', async () => {
  respond = routeTo(slowTrain, erail(['13011']));
  await withApp(async (get) => {
    await Promise.all([get('/search?from=YPR&to=NZM&date=2026-12-01'), get('/schedule?train=13011')]);
  });
  assert.equal(irctcCalls().length, 1);
});

test('pop-ups count against the global budget, and stop when it is used up', async () => {
  process.env.TRAIN_API_REQUEST_BUDGET = '1';
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail(['13023']));
  await withApp(async (get) => {
    const first = await get('/schedule?train=13021');
    assert.equal(first.body.meta.source, 'irctc');
    const second = await get('/schedule?train=13022');
    assert.equal(second.status, 200);
    assert.equal(second.body.meta.source, 'timetable', 'falls back to the timetable');
    assert.equal(second.body.meta.verification.status, 'budget_exhausted');
    const search = await get('/search?from=YPR&to=NZM&date=2026-12-02');
    assert.equal(search.body.meta.verification.status, 'budget_exhausted');
  });
  assert.equal(irctcCalls().length, 1);
});

test('a pop-up for a train IRCTC just answered empty for sends no second request', async () => {
  respond = routeTo(() => ({ status: 200, headers: {}, data: { body: [{ trains: [] }] } }), erail([]));
  await withApp(async (get) => {
    await irctc.lookupTrain('13031');
    const { body } = await get('/schedule?train=13031');
    assert.equal(body.meta.source, 'timetable');
  });
  assert.equal(irctcCalls().length, 1);
});

// --- off when the budget is 0 or unset ------------------------------------------

for (const [label, value] of [['unset', undefined], ['0', '0'], ['blank', ' '], ['invalid', 'lots']]) {
  test(`TRAIN_API_REQUEST_BUDGET ${label}: no IRCTC request from any path`, async () => {
    if (value === undefined) delete process.env.TRAIN_API_REQUEST_BUDGET;
    else process.env.TRAIN_API_REQUEST_BUDGET = value;
    respond = routeTo(noIrctc, erail(['13041']));
    await withApp(async (get) => {
      const search = await get('/search?from=YPR&to=NZM&date=2026-12-03');
      assert.equal(search.body.meta.verification.status, 'disabled');
      assert.equal(search.body.results[0].source, 'schedule');
      const popup = await get('/schedule?train=13041');
      assert.equal(popup.body.meta.verification.status, 'disabled');
      const seats = await get('/class-availability?trainNumber=13041&classType=SL&from=YPR&to=NZM&date=2026-12-03');
      assert.equal(seats.body.live, false);
    });
    await assert.rejects(irctc.lookupTrain('13042'), { reason: 'disabled' });
    assert.equal(irctc.requestBudgetStatus().enabled, false);
    assert.equal(irctcCalls().length, 0);
    assert.ok(!fs.existsSync(USAGE_FILE), 'nothing counted');
  });
}

test('the startup status and the usage command send no request', () => {
  const env = { ...process.env, TRAIN_API_USAGE_FILE: USAGE_FILE, TRAIN_API_REQUEST_BUDGET: '0', RAPIDAPI_KEY: 'fake' };
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/irctc-usage.js')], { env, encoding: 'utf8' });
  assert.match(out, /Live requests: +OFF/);
  assert.ok(!fs.existsSync(USAGE_FILE), 'showing the status writes nothing');
  assert.equal(irctcCalls().length, 0);
});

// --- manual budget reset ------------------------------------------------------------

test('a reset is refused without explicit confirmation', () => {
  assert.throws(() => irctc.startNewBudgetPeriod(), /without explicit confirmation/);
  assert.throws(() => irctc.startNewBudgetPeriod({ confirm: 'yes' }), /without explicit confirmation/);
  const env = { ...process.env, TRAIN_API_USAGE_FILE: USAGE_FILE };
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts/irctc-usage.js'), '--reset'], { env, stdio: 'pipe' }),
    (err) => err.status === 1 && /without --confirm/.test(err.stderr.toString()));
});

test('a confirmed reset restarts the local count and keeps the old one', async () => {
  process.env.TRAIN_API_REQUEST_BUDGET = '2';
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('13051');
  await irctc.lookupTrain('13052');
  await assert.rejects(irctc.lookupTrain('13053'), { reason: 'budget_exhausted' });

  const status = irctc.startNewBudgetPeriod({ confirm: true });
  assert.equal(status.requestsSent, 0);
  assert.equal(status.period.startedBy, 'manual');
  assert.equal(savedUsage().history[0].requestsSent, 2, 'earlier count archived, not discarded');
  await irctc.lookupTrain('13053');
  assert.equal(irctcCalls().length, 3);
});

test('a reset does not lift a 429 block — it is not proof the quota renewed', async () => {
  respond = () => httpError(429, 'quota', { 'x-ratelimit-requests-reset': '86400' });
  await assert.rejects(irctc.lookupTrain('13061'), { reason: 'rate_limited' });
  irctc.startNewBudgetPeriod({ confirm: true });
  await assert.rejects(irctc.lookupTrain('13062'), { reason: 'rate_limited' });
  assert.equal(irctcCalls().length, 1);
  assert.equal(irctc.requestBudgetStatus().blockReason, 'rate_limited');
});

test('a reset does not lift a 403 block', async () => {
  respond = () => httpError(403, 'not subscribed');
  await assert.rejects(irctc.lookupTrain('13071'), { reason: 'not_subscribed' });
  irctc.startNewBudgetPeriod({ confirm: true });
  await assert.rejects(irctc.lookupTrain('13072'), { reason: 'not_subscribed' });
  assert.equal(irctcCalls().length, 1);
});

test('a reset does not override RapidAPI reporting 0 left, even with no reset time given', async (t) => {
  respond = (url) => irctcTrain(url.split('/').pop(), { 'x-ratelimit-requests-remaining': '0' });
  await irctc.lookupTrain('13081');
  irctc.startNewBudgetPeriod({ confirm: true });
  await assert.rejects(irctc.lookupTrain('13082'), { reason: 'rate_limited' });
  assert.equal(irctcCalls().length, 1);

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 25 * 60 * 60 * 1000);
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('13082');
  assert.equal(irctcCalls().length, 2, 'only after the fallback wait');
});

test('a running server sees a reset made by the command, and does not overwrite it', async () => {
  process.env.TRAIN_API_REQUEST_BUDGET = '1';
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('13091');
  await assert.rejects(irctc.lookupTrain('13092'), { reason: 'budget_exhausted' });

  const env = { ...process.env, TRAIN_API_USAGE_FILE: USAGE_FILE };
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/irctc-usage.js'), '--reset', '--confirm'], { env, encoding: 'utf8' });
  assert.match(out, /RapidAPI quota itself is unchanged/);

  await irctc.lookupTrain('13092');
  assert.equal(irctcCalls().length, 2);
  const saved = savedUsage();
  assert.equal(saved.requestsSent, 1);
  assert.equal(saved.history.length, 1);
});

test('an unreadable usage file is not reset', () => {
  fs.writeFileSync(USAGE_FILE, 'garbage');
  assert.throws(() => irctc.startNewBudgetPeriod({ confirm: true }), /can't be read/);
  assert.equal(fs.readFileSync(USAGE_FILE, 'utf8'), 'garbage');
});

// --- cache behaviour ----------------------------------------------------------------

test('after the week-long cache expires, a train needs budget again — none means timetable', async (t) => {
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail(['13101']));
  await irctc.lookupTrain('13101');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 8 * 24 * 60 * 60 * 1000);
  process.env.TRAIN_API_REQUEST_BUDGET = '0';
  await withApp(async (get) => {
    const { body } = await get('/search?from=YPR&to=NZM&date=2026-12-04');
    assert.equal(body.results[0].source, 'schedule', 'expired IRCTC data is not shown as verified');
    assert.equal(body.meta.dataStatus, 'timetable');
  });
  assert.equal(irctcCalls().length, 1);
});

test('within the week, cached IRCTC data is labelled cached in searches and pop-ups', async () => {
  respond = routeTo((url) => irctcTrain(url.split('/').pop()), erail(['13111']));
  const first = await irctc.lookupTrain('13111');
  process.env.TRAIN_API_REQUEST_BUDGET = '0';
  await withApp(async (get) => {
    const search = await get('/search?from=YPR&to=NZM&date=2026-12-05');
    assert.equal(search.body.results[0].source, 'cached-schedule');
    assert.equal(search.body.results[0].verifiedAt, first.respondedAt);
    const popup = await get('/schedule?train=13111');
    assert.equal(popup.body.meta.status, 'cached');
    assert.equal(popup.body.meta.live, false);
    assert.equal(popup.body.meta.respondedAt, first.respondedAt);
  });
  assert.equal(irctcCalls().length, 1);
});
