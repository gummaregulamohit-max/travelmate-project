// The "Indian Railway IRCTC" integration, offline: axios.get is stubbed with
// payloads shaped like real API responses, so these tests spend no RapidAPI
// quota and never see the real key.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.RAPIDAPI_KEY = 'test-key-not-real';
// Live requests "on" against stubbed axios, counted in a throwaway file.
process.env.TRAIN_API_REQUEST_BUDGET = '1000';
process.env.TRAIN_API_USAGE_FILE = path.join(os.tmpdir(), `travelmate-irctc-service-test-${process.pid}.json`);
const irctc = require('../src/services/irctc.service');
const { fetchErailTrains } = require('../src/services/erail.service');

const realGet = axios.get;
let calls;
let respond;
beforeEach(() => {
  calls = [];
  axios.get = async (url, opts) => {
    calls.push({ url, opts });
    return respond(url, opts);
  };
});
afterEach(() => {
  axios.get = realGet;
  fs.rmSync(process.env.TRAIN_API_USAGE_FILE, { force: true });
  irctc.resetStateForTests();
});

function stop(code, name, arr, dep, halt, km, day) {
  return { stationCode: code, stationName: name, arrivalTime: arr, departureTime: dep, routeNumber: '1', haltTime: halt, distance: String(km), dayCount: String(day), status: 'ACTIVE' };
}

// Trimmed from a live GET /api/trains-search/v1/train/12629 response.
function irctcTrain(trainNumber, runningOn = 'NNYNYNN') {
  return {
    status: 200,
    headers: { 'x-ratelimit-requests-remaining': '40' },
    data: { body: [{ title: 'All Trains', trains: [{
      trainNumber, trainName: 'Sampark Kranti', stationFrom: 'YPR', stationTo: 'NZM', runningOn,
      journeyClasses: ['1A', '2A', '3A', 'SL'],
      schedule: [
        stop('YPR', 'Yesvantpur Jn', '--', '15:00', '--', 0, 1),
        stop('GTL', 'Guntakal Jn', '19:10', '19:20', '10:00', 290, 1),
        stop('NZM', 'H Nizamuddin', '11:40', '--', '--', 2380, 3)
      ]
    }] }] }
  };
}

function erailBody(trainNumber, dayBits) {
  const f = Array(30).fill('');
  Object.assign(f, { 0: trainNumber, 1: 'SAMPARK KRANTI', 7: 'YPR', 9: 'NZM', 10: '15.00', 12: '44.40', 13: dayBits, 21: '01100' });
  f.push('DATASOURCE_IR', '', '', 'EXP:2380:0,0:1500,0:1100,0');
  return `header^${f.join('~')}`;
}

test('IRCTC runningOn is read Sunday first and shifted to later-day stops', () => {
  assert.equal(irctc.describeDays(irctc.runningDaysAt('NNYNYNN', 1)), 'Runs on Tue, Thu');
  assert.equal(irctc.describeDays(irctc.runningDaysAt('NNYNYNN', 3)), 'Runs on Thu, Sat');
  assert.equal(irctc.describeDays(irctc.runningDaysAt('YYYYYYY', 2)), 'Runs Daily');
  assert.equal(irctc.runningDaysAt('bad', 1), null);
});

test('erail running-day bits are read Monday first', async () => {
  respond = () => ({ data: erailBody('12028', '1011111') });
  const label = (c) => c;
  const [wed] = await fetchErailTrains('SBC', 'MAS', '2026-10-14', label);
  assert.equal(wed.days, 'Runs on Sun, Mon, Wed, Thu, Fri, Sat');
  assert.deepEqual(await fetchErailTrains('SBC', 'MAS', '2026-10-13', label), [], 'no train on a Tuesday');
});

test('the schedule endpoint maps IRCTC stops to the /api/trains/schedule shape', async () => {
  respond = () => irctcTrain('12629');
  const schedule = await irctc.fetchIrctcSchedule('12629');
  assert.match(calls[0].url, /^https:\/\/indian-railway-irctc\.p\.rapidapi\.com\/api\/trains-search\/v1\/train\/12629$/);
  assert.equal(calls[0].opts.headers['x-rapidapi-host'], 'indian-railway-irctc.p.rapidapi.com');
  assert.deepEqual(schedule.train, { number: '12629', name: 'Sampark Kranti', fromCode: 'YPR', fromName: 'Yesvantpur Jn', toCode: 'NZM', toName: 'H Nizamuddin', days: 'Runs on Tue, Thu' });
  assert.deepEqual(schedule.stops[0], { code: 'YPR', name: 'Yesvantpur Jn', routeNumber: 1, arrival: null, departure: '15:00', halt: null, distance: 0, day: 1 });
  assert.deepEqual(schedule.stops[1], { code: 'GTL', name: 'Guntakal Jn', routeNumber: 1, arrival: '19:10', departure: '19:20', halt: 10, distance: 290, day: 1 });
  assert.equal(schedule.stops[2].departure, null);
});

const emptyAnswer = () => ({ status: 200, headers: {}, data: { body: [{ title: 'All Trains', trains: [], queryText: '0' }] } });

test('an empty 200 is not retried', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let n = 0;
  respond = () => (++n === 1 ? emptyAnswer() : irctcTrain('99900'));
  assert.equal(await irctc.fetchTrainDetails('99900'), null);
  assert.equal(calls.length, 1);
});

test('an empty answer is cached for an hour, not a week', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = emptyAnswer;
  assert.equal(await irctc.fetchTrainDetails('99901'), null);
  assert.equal(calls.length, 1, 'no retry');
  await irctc.fetchTrainDetails('99901');
  assert.equal(calls.length, 1, 'served from cache');

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 2 * 60 * 60 * 1000);
  respond = () => irctcTrain('99901');
  assert.equal((await irctc.fetchTrainDetails('99901')).trainNumber, '99901');
  assert.equal(calls.length, 2, 're-fetched after the short TTL');
});

test('quota exhaustion surfaces as rateLimited without leaking the key', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = () => {
    const err = new Error('Request failed with status code 429');
    err.response = { status: 429, data: { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.' } };
    throw err;
  };
  await assert.rejects(irctc.fetchTrainDetails('99902'), (err) => {
    assert.equal(err.rateLimited, true);
    assert.match(err.message, /MONTHLY quota/);
    assert.ok(!JSON.stringify({ m: err.message, d: err.details }).includes(process.env.RAPIDAPI_KEY));
    return true;
  });
});

test('after a 429 no request is sent until the quota resets, and nothing is retried', async (t) => {
  t.mock.method(console, 'warn', () => {});
  respond = () => {
    const err = new Error('Request failed with status code 429');
    err.response = { status: 429, headers: { 'x-ratelimit-requests-reset': '3600' }, data: { message: 'You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.' } };
    throw err;
  };
  await assert.rejects(irctc.fetchTrainDetails('99910'), { rateLimited: true });
  assert.equal(calls.length, 1, 'no retry after a 429');
  await assert.rejects(irctc.fetchTrainDetails('99911'), (err) => {
    assert.equal(err.rateLimited, true);
    assert.match(err.message, /used up its request quota/);
    return true;
  });
  assert.equal(calls.length, 1, 'blocked without a request');

  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 3601 * 1000);
  respond = () => irctcTrain('99911');
  assert.equal((await irctc.fetchTrainDetails('99911')).trainNumber, '99911');
  assert.equal(calls.length, 2, 'requests resume after the reset time');
});

test('a key without a subscription (403) is reported as notSubscribed and not retried', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  respond = () => {
    const err = new Error('Request failed with status code 403');
    err.response = { status: 403, headers: {}, data: { message: 'You are not subscribed to this API.' } };
    throw err;
  };
  await assert.rejects(irctc.fetchTrainDetails('99912'), (err) => {
    assert.equal(err.notSubscribed, true);
    assert.equal(err.rateLimited, false);
    return true;
  });
  await assert.rejects(irctc.fetchTrainDetails('99913'), /not subscribed to the Indian Railway IRCTC API/);
  assert.equal(calls.length, 1, 'blocked for an hour without further requests');
  const logged = JSON.stringify(warn.mock.calls.map((c) => c.arguments));
  assert.ok(!logged.includes(process.env.RAPIDAPI_KEY), 'the key is never logged');
});

test('the documented endpoint, parameters and headers are used', async () => {
  respond = () => irctcTrain('12630');
  await irctc.fetchTrainDetails('12630');
  const { url, opts } = calls[0];
  assert.equal(url, 'https://indian-railway-irctc.p.rapidapi.com/api/trains-search/v1/train/12630');
  assert.deepEqual(opts.params, { isH5: true, client: 'web' });
  assert.deepEqual(Object.keys(opts.headers).sort(), ['x-rapid-api', 'x-rapidapi-host', 'x-rapidapi-key']);
  assert.equal(opts.headers['x-rapid-api'], 'rapid-api-database');
});

test('TRAIN_API_MAX_LOOKUPS_PER_SEARCH: 0 is honoured, blank uses the default, bad values are bounded', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(irctc.parseMaxLookups(undefined), 3);
  assert.equal(irctc.parseMaxLookups('  '), 3);
  assert.equal(irctc.parseMaxLookups('0'), 0);
  assert.equal(irctc.parseMaxLookups(' 2 '), 2);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(irctc.parseMaxLookups('50'), 10);
  for (const bad of ['-1', 'abc', '1.5', '2x']) assert.equal(irctc.parseMaxLookups(bad), 3, bad);
  assert.equal(warn.mock.callCount(), 5);
});

test('with TRAIN_API_MAX_LOOKUPS_PER_SEARCH=0 a route search makes no IRCTC request', async () => {
  const modulePath = require.resolve('../src/services/irctc.service');
  const original = require.cache[modulePath];
  delete require.cache[modulePath];
  process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH = '0';
  try {
    const fresh = require(modulePath);
    assert.equal(fresh.MAX_LOOKUPS_PER_SEARCH, 0);
    respond = (url) => {
      if (url.includes('erail.in')) return { data: erailBody('99905', '1111111') };
      throw new Error(`unexpected IRCTC request: ${url}`);
    };
    const { trains } = await fresh.searchLiveTrains({ fromCode: 'YPR', toCode: 'NZM', date: '2026-10-12' });
    assert.deepEqual(trains.map((tr) => [tr.trainNumber, tr.source]), [['99905', 'schedule']]);
    assert.ok(calls.every((c) => c.url.includes('erail.in')));
  } finally {
    delete process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH;
    require.cache[modulePath] = original;
  }
});

test('route search keeps the timetable shape, applies IRCTC timings, drops non-running trains', async () => {
  respond = (url) => {
    if (url.includes('erail.in')) {
      return { data: `${erailBody('99903', '1111111')}^${erailBody('99904', '1111111').split('^')[1]}` };
    }
    return url.endsWith('/99903') ? irctcTrain('99903', 'YYYYYYY') : irctcTrain('99904', 'NNYNYNN');
  };
  // 2026-10-12 is a Monday: IRCTC says 99904 runs only Tue/Thu.
  const { trains, rateLimited } = await irctc.searchLiveTrains({ fromCode: 'YPR', toCode: 'NZM', date: '2026-10-12' });
  assert.equal(rateLimited, false);
  assert.deepEqual(trains.map((t) => t.trainNumber), ['99903']);
  const [train] = trains;
  assert.equal(train.source, 'live-schedule');
  assert.equal(train.departureTime, '15:00');
  assert.equal(train.arrivalTime, '11:40 (+2)');
  assert.equal(train.days, 'Runs Daily');
  assert.ok(!('runsOnDate' in train));
  for (const key of ['trainNumber', 'trainName', 'trainType', 'fromStation', 'toStation', 'duration', 'classes', 'classesAvailable']) {
    assert.ok(key in train, `has ${key}`);
  }
});
