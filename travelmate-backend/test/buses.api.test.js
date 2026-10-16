const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

const SEARCH = '/api/buses/search?from=Bengaluru&to=Chennai&date=2026-11-20';

let server;
before(async () => { server = await startServer(); });
after(() => server.stop());

test('the bus router is mounted: /api/buses/search is a 200, not a 404', async () => {
  const { status, body } = await server.get(SEARCH);
  assert.equal(status, 200);
  assert.ok(body.results.length >= 6 && body.results.length <= 10, `got ${body.results.length} buses`);
  assert.equal(body.meta.count, body.results.length);
  assert.deepEqual([body.meta.from, body.meta.to, body.meta.date], ['Bengaluru', 'Chennai', '2026-11-20']);
});

test('bus results are labelled simulated, with a notice', async () => {
  const { body } = await server.get(SEARCH);
  assert.equal(body.meta.source, 'simulated');
  assert.match(body.meta.notice, /simulated/i);
  assert.match(body.meta.notice, /not live inventory/i);
  for (const bus of body.results) {
    assert.equal(bus.simulated, true, bus.id);
    assert.equal(bus.fareIsEstimate, true, bus.id);
  }
});

test('bus results invent no seat availability and no booking link', async () => {
  const { body } = await server.get(SEARCH);
  for (const bus of body.results) {
    assert.ok(!('seatsAvailable' in bus), `${bus.id} has seatsAvailable`);
    assert.ok(!('bookingUrl' in bus), `${bus.id} has bookingUrl`);
    assert.match(bus.checkAvailabilityUrl, /^https:\/\//, bus.id);
    assert.match(bus.checkAvailabilityLabel, /^Check real buses on /, bus.id);
  }
});

test('government buses point to their RTC site, private ones to redBus', async () => {
  const { body } = await server.get(SEARCH);
  for (const bus of body.results) {
    if (bus.isGovt) assert.doesNotMatch(bus.checkAvailabilityUrl, /redbus/, bus.id);
    else {
      assert.equal(bus.checkAvailabilityUrl, 'https://www.redbus.in/bus-tickets/bengaluru-to-chennai', bus.id);
      assert.equal(bus.checkAvailabilityLabel, 'Check real buses on redBus');
    }
  }
});

test('the same search returns the same simulated buses', async () => {
  const [a, b] = await Promise.all([server.get(SEARCH), server.get(SEARCH)]);
  assert.deepEqual(a.body, b.body);
});

test('a DD-MM-YYYY date is accepted', async () => {
  const { status, body } = await server.get('/api/buses/search?from=Bengaluru&to=Chennai&date=20-11-2026');
  assert.equal(status, 200);
  assert.equal(body.meta.date, '2026-11-20');
});

test('missing or invalid parameters are a 400', async () => {
  const cases = {
    '?to=Chennai&date=2026-11-20': 'A valid "from" city is required.',
    '?from=Bengaluru&date=2026-11-20': 'A valid "to" city is required.',
    '?from=%20&to=Chennai&date=2026-11-20': 'A valid "from" city is required.',
    '?from=Bengaluru&to=bengaluru&date=2026-11-20': 'Origin and destination cannot be the same city.',
    '?from=Bengaluru&to=Chennai': 'A valid "date" is required, as YYYY-MM-DD or DD-MM-YYYY.',
    '?from=Bengaluru&to=Chennai&date=tomorrow': 'A valid "date" is required, as YYYY-MM-DD or DD-MM-YYYY.'
  };
  for (const [qs, message] of Object.entries(cases)) {
    const { status, body } = await server.get(`/api/buses/search${qs}`);
    assert.equal(status, 400, qs);
    assert.deepEqual(body, { error: { message, status: 400 } }, qs);
  }
});

test('TravelMate.html shows the simulated-results notice above the bus results', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'TravelMate.html'), 'utf8');
  const notice = /<p class="ab-sim-notice" id="busSimNotice" role="note">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(notice, 'busSimNotice is missing');
  assert.match(notice[1], /Simulated results/);
  assert.match(notice[1], /schedules, fares and seat information/);
  assert.match(notice[1], /not live inventory/);
  const results = html.indexOf('<div id="busResults"');
  const list = html.indexOf('<div id="busResultsList">');
  assert.ok(results < notice.index && notice.index < list, 'the notice should sit inside #busResults, above the list');
});

test('an unknown /api/buses path is a JSON 404', async () => {
  const { status, body } = await server.get('/api/buses/nope');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: { message: 'Not found.', status: 404 } });
});
