const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer } = require('./helpers/server');

const { version } = require(path.join(__dirname, '..', 'package.json'));

// Obviously fake placeholders — the point is to prove they never leak.
const FAKE_KEYS = {
  SERPAPI_KEY: 'fake-serpapi-key-for-health-test-7731',
  RAPIDAPI_KEY: 'fake-rapidapi-key-for-health-test-4482'
};

let keyless;
let configured;
before(async () => {
  [keyless, configured] = await Promise.all([startServer(), startServer({ env: FAKE_KEYS })]);
});
after(() => Promise.all([keyless.stop(), configured.stop()]));

test('GET /api/health is a 200 with status, version, uptime and timestamp', async () => {
  const { status, body } = await keyless.get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.version, version);
  assert.ok(Number.isInteger(body.uptimeSeconds) && body.uptimeSeconds >= 0, `uptimeSeconds was ${body.uptimeSeconds}`);
  assert.ok(Math.abs(Date.parse(body.timestamp) - Date.now()) < 60000, `timestamp was ${body.timestamp}`);
  assert.deepEqual(Object.keys(body).sort(), ['providers', 'status', 'timestamp', 'uptimeSeconds', 'version']);
});

test('providers report configured: false when no keys are set', async () => {
  const { body } = await keyless.get('/api/health');
  assert.deepEqual(body.providers, {
    flights: { provider: 'SerpApi (Google Flights)', configured: false, fallback: null },
    trains: { provider: 'Indian Railway IRCTC (RapidAPI)', configured: false, fallback: 'erail.in timetable' },
    buses: { provider: 'simulated', configured: true, fallback: null }
  });
});

test('providers report configured: true when keys are set', async () => {
  const { body } = await configured.get('/api/health');
  assert.equal(body.providers.flights.configured, true);
  assert.equal(body.providers.trains.configured, true);
});

test('the health response never contains a key, in the body or the headers', async () => {
  const { text, headers } = await configured.get('/api/health');
  const headerText = JSON.stringify([...headers.entries()]);
  for (const key of Object.values(FAKE_KEYS)) {
    assert.ok(!text.includes(key), 'a key appears in the body');
    assert.ok(!headerText.includes(key), 'a key appears in the headers');
    // Not even a recognizable piece of one
    assert.ok(!text.includes(key.slice(-8)), 'part of a key appears in the body');
  }
});

test('the health response is not cached', async () => {
  const { headers } = await keyless.get('/api/health');
  assert.equal(headers.get('cache-control'), 'no-store');
});

test('/api/health/<anything> is a JSON 404', async () => {
  const { status, body } = await keyless.get('/api/health/details');
  assert.equal(status, 404);
  assert.deepEqual(body, { error: { message: 'Not found.', status: 404 } });
});
