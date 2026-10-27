const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { queryString, parseLimit } = require(path.join(ROOT, 'src/utils/requestNormalizers'));

test('queryString: a string is trimmed', () => {
  assert.equal(queryString('  CSMT '), 'CSMT');
  assert.equal(queryString(''), '');
  assert.equal(queryString('   '), '');
});

test('queryString: a repeated parameter uses its first value', () => {
  assert.equal(queryString(['CSMT', 'MMCT']), 'CSMT');
  assert.equal(queryString([' Mumbai ', 'Delhi']), 'Mumbai');
});

test('queryString: missing or non-string values are empty', () => {
  for (const value of [undefined, null, 5, {}, { x: 'CSMT' }, [], [{ x: 'CSMT' }]]) {
    assert.equal(queryString(value), '', JSON.stringify(value));
  }
});

test('parseLimit: whole numbers are clamped to 1..max', () => {
  assert.equal(parseLimit('5'), 5);
  assert.equal(parseLimit('0'), 1);
  assert.equal(parseLimit('-5'), 1);
  assert.equal(parseLimit('100'), 100);
  assert.equal(parseLimit('500'), 100);
  assert.equal(parseLimit(' 7 '), 7);
});

test('parseLimit: missing or non-numeric values fall back to the default', () => {
  for (const value of [undefined, '', 'abc', '2.5', '5abc', '1e3', {}]) {
    assert.equal(parseLimit(value), 20, JSON.stringify(value));
  }
});

test('parseLimit: a repeated limit uses its first value', () => {
  assert.equal(parseLimit(['3', '50']), 3);
});

test('parseLimit: fallback and max can be set', () => {
  assert.equal(parseLimit(undefined, { fallback: 5 }), 5);
  assert.equal(parseLimit('80', { max: 50 }), 50);
});

// --- travel dates ---------------------------------------------------------------

const { normalizeDateToISO, checkTravelDate, travelDateMessage, earliestTravelDate, travelClockMs, travelDateOverrideIgnored } = require(path.join(ROOT, 'src/utils/requestNormalizers'));

const setEnv = (name, value) => { if (value == null) delete process.env[name]; else process.env[name] = value; };
const originalEnv = new WeakMap();
// Pins "today" (TRAVELMATE_TODAY) and NODE_ENV — "test" unless given; null
// unsets it — for one test; however often it is called, the values from before
// the test come back.
function today(t, iso, nodeEnv = 'test') {
  if (!originalEnv.has(t)) {
    originalEnv.set(t, { today: process.env.TRAVELMATE_TODAY, nodeEnv: process.env.NODE_ENV });
    t.after(() => {
      const before = originalEnv.get(t);
      setEnv('TRAVELMATE_TODAY', before.today);
      setEnv('NODE_ENV', before.nodeEnv);
    });
  }
  setEnv('NODE_ENV', nodeEnv);
  setEnv('TRAVELMATE_TODAY', iso);
}
const isoDaysFromNow = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

test('normalizeDateToISO: both accepted formats still give YYYY-MM-DD', (t) => {
  today(t, '2026-10-20');
  assert.equal(normalizeDateToISO('2026-11-22'), '2026-11-22');
  assert.equal(normalizeDateToISO('22-11-2026'), '2026-11-22');
  assert.equal(normalizeDateToISO(' 2026-11-22 '), '2026-11-22');
  assert.equal(normalizeDateToISO('2028-02-29'), '2028-02-29', 'a leap day');
});

test('normalizeDateToISO: anything else is still null', (t) => {
  today(t, '2026-10-20');
  for (const bad of [undefined, null, '', 'tomorrow', '2026/11/22', '22/11/2026', '2026-11-2', 42, ['2026-11-22']]) {
    assert.equal(normalizeDateToISO(bad), null, String(bad));
  }
});

test('normalizeDateToISO: a date that is not on the calendar is null', (t) => {
  today(t, '2026-10-20');
  for (const bad of ['2026-13-45', '2026-02-31', '2026-00-10', '2026-04-31', '31-02-2026', '2027-02-29']) {
    assert.equal(normalizeDateToISO(bad), null, bad);
    assert.equal(checkTravelDate(bad).error, 'invalid', bad);
  }
});

test('normalizeDateToISO: a past travel date is null; yesterday is allowed for time zones', (t) => {
  today(t, '2026-10-20');
  assert.equal(earliestTravelDate(), '2026-10-19');
  assert.equal(normalizeDateToISO('2026-10-20'), '2026-10-20', 'today');
  assert.equal(normalizeDateToISO('2026-10-19'), '2026-10-19', 'yesterday (still today somewhere)');
  assert.equal(normalizeDateToISO('2026-10-18'), null);
  assert.equal(normalizeDateToISO('18-10-2026'), null, 'DD-MM-YYYY too');
  assert.equal(normalizeDateToISO('2025-12-31'), null);
  assert.deepEqual({ ...checkTravelDate('2026-10-18') }, { date: null, error: 'past', iso: '2026-10-18' });
});

test('normalizeDateToISO: allowPast keeps past dates for callers that need them', (t) => {
  today(t, '2026-10-20');
  assert.equal(normalizeDateToISO('2026-10-01', { allowPast: true }), '2026-10-01');
  assert.equal(normalizeDateToISO('2026-02-31', { allowPast: true }), null, 'still a real date only');
});

test('normalizeDateToISO: without a pinned day, "today" is the real date', (t) => {
  today(t, undefined);
  assert.equal(normalizeDateToISO(isoDaysFromNow(0)), isoDaysFromNow(0));
  assert.equal(normalizeDateToISO(isoDaysFromNow(30)), isoDaysFromNow(30));
  assert.equal(normalizeDateToISO(isoDaysFromNow(-3)), null);
});

test('TRAVELMATE_TODAY: an invalid value is ignored (the real clock is used)', (t) => {
  for (const bad of ['yesterday', '2026-02-31', '20-10-2026']) {
    today(t, bad);
    assert.ok(Math.abs(travelClockMs() - Date.now()) < 5000, bad);
  }
});

test('TRAVELMATE_TODAY only applies when NODE_ENV=test — in production, development or with NODE_ENV unset it is ignored', (t) => {
  for (const nodeEnv of ['production', 'development', null]) {
    today(t, '2026-10-20', nodeEnv);
    const label = nodeEnv || 'NODE_ENV unset';
    assert.equal(process.env.NODE_ENV, nodeEnv || undefined, `${label}: set up as intended`);
    assert.ok(Math.abs(travelClockMs() - Date.now()) < 5000, `${label}: the real clock is used`);
    assert.equal(travelDateOverrideIgnored(), true, `${label}: reported as ignored (server.js warns at startup)`);
    assert.equal(normalizeDateToISO(isoDaysFromNow(-3)), null, `${label}: a date in the real past stays refused`);
  }
  today(t, '2026-10-20', 'test');
  assert.equal(travelClockMs(), Date.parse('2026-10-20T12:00:00Z'), 'test: the pinned day is used');
  assert.equal(travelDateOverrideIgnored(), false);
});

test('travelDateOverrideIgnored: nothing to report when TRAVELMATE_TODAY is not set', (t) => {
  for (const nodeEnv of ['production', 'test', null]) {
    today(t, undefined, nodeEnv);
    assert.equal(travelDateOverrideIgnored(), false, nodeEnv || 'NODE_ENV unset');
  }
});

test('travelDateMessage: says which date and why', (t) => {
  today(t, '2026-10-20');
  assert.equal(travelDateMessage(checkTravelDate('2026-10-01'), 'departureDate'), '"departureDate" (2026-10-01) is in the past — choose today or a later date.');
  assert.equal(travelDateMessage(checkTravelDate('soon')), 'A valid "date" is required, as YYYY-MM-DD or DD-MM-YYYY.');
});
