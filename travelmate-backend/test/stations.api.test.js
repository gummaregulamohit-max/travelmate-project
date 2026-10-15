const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

let server;
before(async () => { server = await startServer(); });
after(() => server.stop());

const CSMT = { name: 'Chhatrapati Shivaji Maharaj Terminus', code: 'CSMT', city: 'Mumbai', state: 'Maharashtra' };

test('CSMT returns exactly the CSMT terminus', async () => {
  const { status, body } = await server.get('/api/trains/stations?q=CSMT');
  assert.equal(status, 200);
  assert.deepEqual(body, { results: [CSMT], meta: { query: 'CSMT', count: 1, total: 1 } });
});

test('station search is case-insensitive', async () => {
  const { status, body } = await server.get('/api/trains/stations?q=csmt');
  assert.equal(status, 200);
  assert.equal(body.results[0].code, 'CSMT');
});

test('station search matches by name', async () => {
  const { body } = await server.get('/api/trains/stations?q=Mumbai%20Central');
  assert.ok(body.results.some((s) => s.code === 'MMCT'), 'MMCT should match "Mumbai Central"');
});

test('ranking: exact code, then code prefix, then name prefix', async () => {
  const { body } = await server.get('/api/trains/stations?q=mas');
  assert.equal(body.results[0].code, 'MAS');
  assert.equal(body.results[1].code, 'MASK');
  assert.ok(body.results[2].name.toLowerCase().startsWith('mas'));
});

test('results expose only name, code, city and state', async () => {
  const { body } = await server.get('/api/trains/stations?q=Mumbai');
  assert.ok(body.results.length > 0);
  for (const s of body.results) assert.deepEqual(Object.keys(s).sort(), ['city', 'code', 'name', 'state']);
  assert.equal(body.meta.count, body.results.length);
});

test('missing, empty and blank q return no results, not the whole directory', async () => {
  for (const qs of ['', '?q=', '?q=%20%20%20', '?limit=100']) {
    const { status, body } = await server.get(`/api/trains/stations${qs}`);
    assert.equal(status, 200, `status for "${qs}"`);
    assert.deepEqual(body, { results: [], meta: { query: '', count: 0, total: 0 } }, `body for "${qs}"`);
  }
});

test('a query with no match returns an empty list, not an error', async () => {
  const { status, body } = await server.get('/api/trains/stations?q=zzzzqq');
  assert.equal(status, 200);
  assert.deepEqual(body, { results: [], meta: { query: 'zzzzqq', count: 0, total: 0 } });
});

test('a repeated q parameter uses its first value', async () => {
  const { status, body } = await server.get('/api/trains/stations?q=CSMT&q=MMCT');
  assert.equal(status, 200);
  assert.deepEqual(body, { results: [CSMT], meta: { query: 'CSMT', count: 1, total: 1 } });
});

test('a non-string q (?q[x]=1) is treated as empty', async () => {
  const { status, body } = await server.get('/api/trains/stations?q[x]=CSMT');
  assert.equal(status, 200);
  assert.equal(body.meta.count, 0);
});

test('q is trimmed', async () => {
  const { body } = await server.get('/api/trains/stations?q=%20CSMT%20');
  assert.equal(body.meta.query, 'CSMT');
  assert.equal(body.results[0].code, 'CSMT');
});

test('a broad query is capped at 20 by default, with the full match count in total', async () => {
  const { body } = await server.get('/api/trains/stations?q=a');
  assert.equal(body.results.length, 20);
  assert.equal(body.meta.count, 20);
  assert.ok(body.meta.total > 1000, `total was ${body.meta.total}`);
});

test('station limit is clamped to 1..100, and non-numeric falls back to 20', async () => {
  const count = async (limit) => (await server.get(`/api/trains/stations?q=a&limit=${limit}`)).body.meta.count;
  assert.equal(await count('5'), 5);
  assert.equal(await count('0'), 1);
  assert.equal(await count('-5'), 1);
  assert.equal(await count('500'), 100);
  assert.equal(await count('abc'), 20);
  assert.equal(await count('2.5'), 20);
});
