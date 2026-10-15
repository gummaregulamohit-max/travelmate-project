const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let server;
before(async () => { server = await startServer(); });
after(() => server.stop());

test('Mumbai resolves to the Mumbai city with its airport, stations and bus points', async () => {
  const { status, body } = await server.get('/api/locations/search?q=Mumbai');
  assert.equal(status, 200);
  assert.deepEqual(body.meta, { query: 'Mumbai', count: body.results.length });

  const [mumbai] = body.results;
  assert.equal(mumbai.name, 'Mumbai');
  assert.equal(mumbai.type, 'City');
  assert.equal(mumbai.state, 'Maharashtra');
  assert.equal(mumbai.country, 'India');
  assert.equal(mumbai.domestic, true);
  assert.deepEqual(mumbai.modes, ['flights', 'trains', 'buses']);
  assert.deepEqual(mumbai.points.airports.map((a) => a.code), ['BOM']);
  const stationCodes = mumbai.points.stations.map((s) => s.code);
  for (const code of ['CSMT', 'MMCT', 'LTT', 'BDTS']) assert.ok(stationCodes.includes(code), `Mumbai should list ${code}`);
  assert.ok(mumbai.points.busPoints.length > 0);
});

test('Mumbai search also returns Navi Mumbai', async () => {
  const { body } = await server.get('/api/locations/search?q=Mumbai');
  const navi = body.results.find((r) => r.name === 'Navi Mumbai');
  assert.ok(navi, 'Navi Mumbai should be suggested');
  assert.deepEqual(navi.points.airports.map((a) => a.code), ['NMI']);
});

test('a station code or an old city name finds the place', async () => {
  const byCode = await server.get('/api/locations/search?q=csmt');
  assert.equal(byCode.body.results[0].name, 'Mumbai');
  const byAlias = await server.get('/api/locations/search?q=Bangalore');
  assert.equal(byAlias.body.results[0].name, 'Bengaluru');
});

test('trip=international keeps only places with an airport, airports only', async () => {
  const { status, body } = await server.get('/api/locations/search?q=Mumbai&trip=international');
  assert.equal(status, 200);
  assert.deepEqual(body.results.map((r) => r.name), ['Mumbai', 'Navi Mumbai']);
  for (const r of body.results) {
    assert.deepEqual(r.modes, ['flights']);
    assert.deepEqual(r.points.stations, []);
    assert.deepEqual(r.points.busPoints, []);
  }
});

test('missing, empty and blank q return no results', async () => {
  for (const qs of ['', '?q=', '?q=%20%20%20']) {
    const { status, body } = await server.get(`/api/locations/search${qs}`);
    assert.equal(status, 200, `status for "${qs}"`);
    assert.deepEqual(body.results, [], `results for "${qs}"`);
    assert.equal(body.meta.count, 0);
  }
});

test('a query with no match returns an empty list, not an error', async () => {
  const { status, body } = await server.get('/api/locations/search?q=zzzzqq');
  assert.equal(status, 200);
  assert.deepEqual(body, { results: [], meta: { query: 'zzzzqq', count: 0 } });
});

test('limit is clamped to 1..100, and non-numeric falls back to 20', async () => {
  const count = async (limit) => (await server.get(`/api/locations/search?q=a&limit=${limit}`)).body.meta.count;
  assert.equal(await count('1'), 1);
  assert.equal(await count('0'), 1);
  assert.equal(await count('-5'), 1);
  assert.equal(await count('500'), 100);
  assert.equal(await count('abc'), 20);
  assert.equal(await count(''), 20);
});

test('a repeated q or limit uses its first value', async () => {
  const { status, body } = await server.get('/api/locations/search?q=Mumbai&q=Delhi&limit=1&limit=50');
  assert.equal(status, 200);
  assert.equal(body.meta.query, 'Mumbai');
  assert.deepEqual(body.results.map((r) => r.name), ['Mumbai']);
});

test('a non-string q (?q[x]=1) returns no results', async () => {
  const { status, body } = await server.get('/api/locations/search?q[x]=Mumbai');
  assert.equal(status, 200);
  assert.deepEqual(body.results, []);
});

test('trip-type: a repeated from uses its first value', async () => {
  const { status, body } = await server.get('/api/locations/trip-type?from=Mumbai&from=London&to=Delhi');
  assert.equal(status, 200);
  assert.equal(body.tripType, 'domestic');
  assert.equal(body.from.name, 'Mumbai');
});

test('trip-type: two Indian places are domestic, one abroad is international', async () => {
  const domestic = await server.get('/api/locations/trip-type?from=Mumbai&to=Delhi');
  assert.equal(domestic.status, 200);
  assert.equal(domestic.body.tripType, 'domestic');
  assert.deepEqual(domestic.body.modes, ['flights', 'trains', 'buses']);

  const international = await server.get('/api/locations/trip-type?from=Mumbai&to=London');
  assert.equal(international.body.tripType, 'international');
  assert.deepEqual(international.body.modes, ['flights']);
});

test('trip-type: an unknown place gives tripType null', async () => {
  const { status, body } = await server.get('/api/locations/trip-type?from=Mumbai&to=zzzzqq');
  assert.equal(status, 200);
  assert.equal(body.tripType, null);
  assert.equal(body.to, null);
});

test('trip-type: a missing from or to is a 400', async () => {
  for (const qs of ['?from=Mumbai', '?to=Delhi', '', '?from=%20&to=Delhi']) {
    const { status, body } = await server.get(`/api/locations/trip-type${qs}`);
    assert.equal(status, 400, `status for "${qs}"`);
    assert.deepEqual(body, { error: { message: 'Both "from" and "to" are required.', status: 400 } });
  }
});
