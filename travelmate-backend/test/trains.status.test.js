// GET /api/trains/search reports where its trains came from — IRCTC
// verification status and cache — offline: axios.get is stubbed with
// erail / IRCTC-shaped payloads, so no RapidAPI quota is spent.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const fs = require('node:fs');
const os = require('node:os');
process.env.RAPIDAPI_KEY = 'fake-rapidapi-key-for-status-tests';
process.env.TRAIN_API_REQUEST_BUDGET = '1000';
process.env.TRAIN_API_USAGE_FILE = path.join(os.tmpdir(), `travelmate-trains-status-test-${process.pid}.json`);
const { resetStateForTests } = require(path.join(ROOT, 'src/services/irctc.service'));

const realGet = axios.get;
let calls;
let respond;
beforeEach(() => {
  calls = [];
  axios.get = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
});
afterEach(() => {
  axios.get = realGet;
  fs.rmSync(process.env.TRAIN_API_USAGE_FILE, { force: true });
  resetStateForTests();
});

// erail.in "trains between stations" record and an IRCTC train-details
// answer, shaped like the live responses (see irctc.service.test.js).
function erailBody(trainNumber) {
  const f = Array(30).fill('');
  Object.assign(f, { 0: trainNumber, 1: 'SAMPARK KRANTI', 7: 'YPR', 9: 'NZM', 10: '15.00', 12: '44.40', 13: '1111111', 21: '01100' });
  f.push('DATASOURCE_IR', '', '', 'EXP:2380:0,0:1500,0:1100,0');
  return `header^${f.join('~')}`;
}

function stop(code, name, arr, dep, day) {
  return { stationCode: code, stationName: name, arrivalTime: arr, departureTime: dep, routeNumber: '1', haltTime: '--', distance: '0', dayCount: String(day) };
}

function irctcTrain(trainNumber) {
  return {
    status: 200,
    headers: {},
    data: { body: [{ trains: [{
      trainNumber, trainName: 'Sampark Kranti', stationFrom: 'YPR', stationTo: 'NZM', runningOn: 'NNYNYNN',
      schedule: [stop('YPR', 'Yesvantpur Jn', '--', '15:00', 1), stop('NZM', 'H Nizamuddin', '11:40', '--', 3)]
    }] }] }
  };
}

function quotaExceeded() {
  const err = new Error('Request failed with status code 429');
  err.response = { status: 429, data: { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.' } };
  throw err;
}

function notSubscribed() {
  const err = new Error('Request failed with status code 403');
  err.response = { status: 403, headers: {}, data: { message: 'You are not subscribed to this API.' } };
  throw err;
}

async function search(query, endpoint = 'search') {
  const app = express();
  app.use('/api/trains', require(path.join(ROOT, 'src/routes/trains.routes')));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/trains/${endpoint}${query}`);
    return { status: res.status, body: await res.json() };
  } finally {
    srv.close();
  }
}

test('trains confirmed by IRCTC are reported as verified', async () => {
  // 2026-11-24 is a Tuesday; the IRCTC fixture runs Tue / Thu
  respond = (url) => (url.includes('erail.in') ? { data: erailBody('12629') } : irctcTrain('12629'));
  const { status, body } = await search('?from=YPR&to=NZM&date=2026-11-24');
  assert.equal(status, 200);
  assert.equal(body.results[0].trainNumber, '12629');
  assert.equal(body.results[0].source, 'live-schedule');
  assert.deepEqual(body.meta.verification, { provider: 'Indian Railway IRCTC (RapidAPI)', status: 'verified', verifiedTrains: 1, liveTrains: 1, cachedTrains: 0, message: null });
  assert.equal(body.meta.dataStatus, 'live_verified');
  assert.ok(body.results[0].verifiedAt, 'carries when IRCTC answered');
  assert.equal(body.meta.cached, false);
});

test('an exhausted RapidAPI quota is reported, and the timetable is still shown', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = (url) => (url.includes('erail.in') ? { data: erailBody('12650') } : quotaExceeded());
  const { status, body } = await search('?from=YPR&to=NZM&date=2026-11-26');
  assert.equal(status, 200);
  assert.equal(body.meta.verification.status, 'rate_limited');
  assert.equal(body.meta.verification.verifiedTrains, 0);
  assert.equal(body.meta.source, 'schedule');
  assert.deepEqual(body.results.map((t) => t.trainNumber), ['12650']);
  assert.equal(body.results[0].source, 'schedule', 'not IRCTC-verified');
  const irctcCalls = calls.filter((c) => c.url.includes('rapidapi'));
  assert.equal(irctcCalls.length, 1, 'stops asking IRCTC after the quota error');

  // The next search sends no IRCTC request at all while the quota is used up.
  respond = (url) => (url.includes('erail.in') ? { data: erailBody('12651') } : assert.fail(`unexpected IRCTC request: ${url}`));
  const next = await search('?from=YPR&to=NZM&date=2026-11-27');
  assert.equal(next.body.meta.verification.status, 'rate_limited');
});

test('a key without a subscription is reported, and the timetable is labelled as reference data', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = (url) => (url.includes('erail.in') ? { data: erailBody('12652') } : notSubscribed());
  const { status, body } = await search('?from=YPR&to=NZM&date=2026-11-28');
  assert.equal(status, 200);
  assert.equal(body.meta.verification.status, 'not_subscribed');
  assert.equal(body.results[0].source, 'schedule');
  assert.equal(body.meta.timetable.source, 'timetable');
  assert.equal(body.meta.timetable.provider, 'erail.in public timetable');
  assert.equal(body.meta.timetable.live, false);
  assert.ok(!Number.isNaN(Date.parse(body.meta.timetable.fetchedAt)));
  assert.equal(calls.filter((c) => c.url.includes('rapidapi')).length, 1, 'one 403, no retries');
  assert.ok(!JSON.stringify(body).includes(process.env.RAPIDAPI_KEY));
});

test('no trains from any source is not reported as live', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = (url) => (url.includes('erail.in') ? { data: 'header' } : irctcTrain('0'));
  const { body } = await search('?from=JTJ&to=GTL&date=2026-11-29');
  assert.deepEqual(body.results, []);
  assert.equal(body.meta.source, 'none');
  assert.equal(body.meta.timetable, null);
});

test('the schedule pop-up says whether its stops are IRCTC or timetable data', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = () => irctcTrain('12653');
  const live = await search('?train=12653', 'schedule');
  assert.equal(live.status, 200);
  assert.equal(live.body.meta.source, 'irctc');
  assert.equal(live.body.meta.live, true);
  assert.equal(live.body.stops.length, 2);

  // Not subscribed: no live answer, so the stops (if any) come from erail and say so.
  respond = (url) => (url.includes('erail.in') ? { data: '' } : notSubscribed());
  const fallback = await search('?train=12654', 'schedule');
  assert.equal(fallback.status, 503, 'unavailable, not "no such train"');
  assert.equal(fallback.body.error.reason, 'not_subscribed');
  assert.doesNotMatch(fallback.body.error.message, /No schedule found/);
  assert.equal(calls.filter((c) => c.url.includes('rapidapi')).length, 2);
});

test('a repeat search is served from cache and says so', async () => {
  respond = (url) => (url.includes('erail.in') ? { data: erailBody('12629') } : irctcTrain('12629'));
  const first = await search('?from=YPR&to=NZM&date=2026-12-01');
  const callsAfterFirst = calls.length;
  const second = await search('?from=YPR&to=NZM&date=2026-12-01');
  assert.equal(first.body.meta.cached, false);
  assert.equal(second.body.meta.cached, true);
  // Served again from cache: the same trains, now labelled cached, never live
  assert.deepEqual(second.body.results.map((t) => t.trainNumber), first.body.results.map((t) => t.trainNumber));
  assert.equal(first.body.results[0].source, 'live-schedule');
  assert.equal(second.body.results[0].source, 'cached-schedule');
  assert.equal(second.body.results[0].verifiedAt, first.body.results[0].verifiedAt, 'keeps the time IRCTC answered');
  assert.equal(second.body.meta.dataStatus, 'cached_verified');
  assert.equal(second.body.meta.verification.status, 'cached');
  assert.equal(second.body.meta.verification.liveTrains, 0);
  assert.equal(second.body.meta.verification.cachedTrains, 1);
  assert.equal(calls.length, callsAfterFirst, 'the cached search made no outside request');
});

test('without a key the verification status is "not_configured"', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = process.env.RAPIDAPI_KEY;
  delete process.env.RAPIDAPI_KEY;
  try {
    respond = (url) => (url.includes('erail.in') ? { data: erailBody('12629') } : irctcTrain('12629'));
    const { body } = await search('?from=YPR&to=NZM&date=2026-12-02');
    assert.equal(body.meta.verification.status, 'not_configured');
    assert.equal(body.meta.source, 'schedule');
    assert.ok(calls.every((c) => !c.url.includes('rapidapi')), 'no IRCTC request without a key');
  } finally {
    process.env.RAPIDAPI_KEY = saved;
  }
});
