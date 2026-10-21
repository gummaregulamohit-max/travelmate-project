// The IRCTC request budget across several backend processes, and budget
// periods from TRAIN_API_QUOTA_RESET_DATE — offline: workers stub axios, the
// usage file is a throwaway, and no RapidAPI request is ever sent.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const WORKER = path.join(__dirname, 'helpers', 'reserve-worker.js');
const USAGE_FILE = path.join(os.tmpdir(), `travelmate-irctc-lock-test-${process.pid}.json`);
const LOCK = `${USAGE_FILE}.lock`;
process.env.RAPIDAPI_KEY = 'fake-rapidapi-key-for-lock-tests';
process.env.TRAIN_API_USAGE_FILE = USAGE_FILE;
delete process.env.TRAIN_API_REQUEST_BUDGET;
delete process.env.TRAIN_API_QUOTA_RESET_DATE;
const irctc = require(path.join(ROOT, 'src/services/irctc.service'));

const realGet = axios.get;
let calls;
let respond;
beforeEach((t) => {
  calls = [];
  axios.get = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
  process.env.TRAIN_API_REQUEST_BUDGET = '1000';
  delete process.env.TRAIN_API_QUOTA_RESET_DATE;
  delete process.env.TRAIN_API_LOCK_TIMEOUT_MS;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
});
afterEach(() => {
  axios.get = realGet;
  for (const f of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(path.basename(USAGE_FILE)))) {
    fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
  irctc.resetStateForTests();
});

const savedUsage = () => JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));

function irctcTrain(trainNumber, headers = {}) {
  return { status: 200, headers, data: { body: [{ trains: [{ trainNumber, trainName: 'X', runningOn: 'YYYYYYY',
    schedule: [{ stationCode: 'YPR', stationName: 'Y', arrivalTime: '--', departureTime: '15:00', dayCount: '1' }] }] }] } };
}

function httpError(status, headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, headers, data: { message: 'provider text' } };
  throw err;
}

// Runs `count` worker processes together; resolves with their JSON results.
async function runWorkers(count, mode, attempts, budget) {
  const startAt = Date.now() + 1500;
  const env = { ...process.env, TRAIN_API_REQUEST_BUDGET: String(budget), TRAIN_API_USAGE_FILE: USAGE_FILE };
  const children = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, [WORKER, mode, String(attempts), String(startAt)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    return once(child, 'exit').then(([code]) => {
      assert.equal(code, 0, err);
      return JSON.parse(out);
    });
  });
  return Promise.all(children);
}

// A process that stays alive until killed, to own a lock.
function liveProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

// --- cross-process budget -----------------------------------------------------

test('six processes reserving at once never exceed the shared budget', async () => {
  const results = await runWorkers(6, 'reserve', 10, 20);
  const ok = results.reduce((n, r) => n + r.ok, 0);
  assert.equal(ok, 20, JSON.stringify(results));
  assert.equal(results.reduce((n, r) => n + (r.reasons.budget_exhausted || 0), 0), 40);
  assert.equal(savedUsage().requestsSent, 20);
  assert.ok(!fs.existsSync(LOCK), 'no lock left behind');
});

test('six processes looking up trains at once send exactly the budget in requests', async () => {
  const results = await runWorkers(6, 'lookup', 8, 15);
  assert.equal(results.reduce((n, r) => n + r.requests, 0), 15, JSON.stringify(results));
  assert.equal(savedUsage().requestsSent, 15);
});

test('a block recorded by one process stops the others', async () => {
  respond = () => httpError(429, { 'x-ratelimit-requests-reset': '3600' });
  await assert.rejects(irctc.lookupTrain('14001'), { reason: 'rate_limited' });
  const [other] = await runWorkers(1, 'lookup', 3, 100);
  assert.equal(other.requests, 0);
  assert.equal(other.reasons.rate_limited, 3);
});

// --- the lock itself ------------------------------------------------------------

test('a lock held by a live process makes a request wait, then give up without sending', async (t) => {
  const owner = liveProcess();
  t.after(() => owner.kill());
  fs.writeFileSync(LOCK, JSON.stringify({ pid: owner.pid, host: os.hostname(), at: new Date().toISOString() }));
  process.env.TRAIN_API_LOCK_TIMEOUT_MS = '150';
  respond = () => assert.fail('no request may be sent');
  await assert.rejects(irctc.lookupTrain('14011'), (err) => {
    assert.equal(err.reason, 'usage_locked');
    assert.equal(err.publicMessage, irctc.REASON_MESSAGES.usage_locked);
    return true;
  });
  assert.ok(fs.existsSync(LOCK), 'a live owner\'s lock is left alone');
  assert.ok(!fs.existsSync(USAGE_FILE), 'nothing counted');
});

test('a lock left by a process that has exited is removed', async () => {
  const gone = liveProcess();
  const pid = gone.pid;
  gone.kill();
  await once(gone, 'exit');
  fs.writeFileSync(LOCK, JSON.stringify({ pid, host: os.hostname(), at: new Date().toISOString() }));
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('14021');
  assert.equal(calls.length, 1);
  assert.equal(savedUsage().requestsSent, 1);
  assert.ok(!fs.existsSync(LOCK));
});

test('a lock older than 30 seconds is removed even if its owner is unknown', async () => {
  fs.writeFileSync(LOCK, 'half-written');
  const old = (Date.now() - 60 * 1000) / 1000;
  fs.utimesSync(LOCK, old, old);
  respond = (url) => irctcTrain(url.split('/').pop());
  await irctc.lookupTrain('14031');
  assert.equal(savedUsage().requestsSent, 1);
});

// --- no retries -----------------------------------------------------------------

for (const [name, answer, reason] of [
  ['a 403', () => httpError(403), 'not_subscribed'],
  ['a 429', () => httpError(429), 'rate_limited'],
  ['RapidAPI reporting 0 left', (url) => irctcTrain(url.split('/').pop(), { 'x-ratelimit-requests-remaining': '0' }), null]
]) {
  test(`${name}: one request, then none — not even from new lookups or a new process`, async () => {
    respond = answer;
    if (reason) await assert.rejects(irctc.lookupTrain('14041'), { reason });
    else await irctc.lookupTrain('14041');
    await assert.rejects(irctc.lookupTrain('14042'), { reason: reason || 'rate_limited' });
    await assert.rejects(irctc.lookupTrain('14043'), { reason: reason || 'rate_limited' });
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0].opts).sort(), ['headers', 'params', 'timeout'], 'no retry options passed to axios');
    const [other] = await runWorkers(1, 'lookup', 2, 100);
    assert.equal(other.requests, 0);
  });
}

test('the backend has no retry library or interceptor', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['axios', 'cors', 'dotenv', 'express']);
  const service = fs.readFileSync(path.join(ROOT, 'src/services/irctc.service.js'), 'utf8');
  assert.doesNotMatch(service, /interceptors|axios-retry|retries\s*:/);
  assert.equal((service.match(/axios\.get\(/g) || []).length, 1, 'one request site');
});

// --- off by default -------------------------------------------------------------

test('with the budget unset, 0 or invalid, nothing is sent and the usage file is not touched', async () => {
  respond = () => assert.fail('no request may be sent');
  for (const value of [undefined, '', '0', '-5', 'ten']) {
    if (value === undefined) delete process.env.TRAIN_API_REQUEST_BUDGET;
    else process.env.TRAIN_API_REQUEST_BUDGET = value;
    await assert.rejects(irctc.lookupTrain('14051'), { reason: 'disabled' }, String(value));
    assert.throws(() => irctc.reserveRequest(), { reason: 'disabled' });
  }
  const [worker] = await runWorkers(1, 'lookup', 2, 0);
  assert.deepEqual(worker, { ok: 0, requests: 0, reasons: { disabled: 2 } });
  assert.ok(!fs.existsSync(USAGE_FILE) && !fs.existsSync(LOCK));
});

// --- periods from TRAIN_API_QUOTA_RESET_DATE ---------------------------------------

const at = (iso, t) => t.mock.method(Date, 'now', () => Date.parse(iso));

test('periods run monthly from the configured reset date', (t) => {
  process.env.TRAIN_API_QUOTA_RESET_DATE = '2026-09-14';
  at('2026-10-20T08:00:00Z', t);
  assert.deepEqual(irctc.configuredPeriod(), { start: '2026-10-14T00:00:00.000Z', end: '2026-11-14T00:00:00.000Z' });
  process.env.TRAIN_API_QUOTA_RESET_DATE = '2026-01-31T05:30:00Z';
  at('2026-03-01T00:00:00Z', t);
  assert.deepEqual(irctc.configuredPeriod(), { start: '2026-02-28T05:30:00.000Z', end: '2026-03-31T05:30:00.000Z' }, 'month-end clamps');
  process.env.TRAIN_API_QUOTA_RESET_DATE = '14th of each month';
  assert.equal(irctc.configuredPeriod(), null, 'invalid: no automatic periods');
});

test('the count restarts when a configured period ends, and the old one is kept', async (t) => {
  process.env.TRAIN_API_QUOTA_RESET_DATE = '2026-09-14';
  process.env.TRAIN_API_REQUEST_BUDGET = '2';
  respond = (url) => irctcTrain(url.split('/').pop());
  at('2026-10-20T08:00:00Z', t);
  await irctc.lookupTrain('14061');
  await irctc.lookupTrain('14062');
  await assert.rejects(irctc.lookupTrain('14063'), { reason: 'budget_exhausted' });

  at('2026-11-13T23:59:00Z', t);
  await assert.rejects(irctc.lookupTrain('14063'), { reason: 'budget_exhausted' }, 'not before the reset date');
  at('2026-11-14T00:00:01Z', t);
  await irctc.lookupTrain('14063');
  const saved = savedUsage();
  assert.equal(saved.requestsSent, 1);
  assert.deepEqual(saved.period, { startedAt: '2026-11-14T00:00:00.000Z', startedBy: 'configured_reset_date', configuredStart: '2026-11-14T00:00:00.000Z' });
  assert.equal(saved.history.at(-1).requestsSent, 2);
  assert.equal(saved.history.at(-1).endedBy, 'configured_reset_date');
});

test('a new local period does not lift a 429 block or RapidAPI\'s "0 left"', async (t) => {
  process.env.TRAIN_API_QUOTA_RESET_DATE = '2026-09-14';
  at('2026-11-13T12:00:00Z', t);
  // RapidAPI says its own reset is 6 days after the configured date
  respond = () => httpError(429, { 'x-ratelimit-requests-reset': String(7 * 24 * 3600) });
  await assert.rejects(irctc.lookupTrain('14071'), { reason: 'rate_limited' });
  at('2026-11-15T00:00:00Z', t);
  await assert.rejects(irctc.lookupTrain('14072'), { reason: 'rate_limited' }, 'still blocked after the local period ended');
  assert.equal(calls.length, 1);

  fs.rmSync(USAGE_FILE);
  irctc.resetStateForTests();
  at('2026-11-13T12:00:00Z', t);
  respond = (url) => irctcTrain(url.split('/').pop(), { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': String(7 * 24 * 3600) });
  await irctc.lookupTrain('14073');
  at('2026-11-15T00:00:00Z', t);
  irctc.resetStateForTests();
  await assert.rejects(irctc.lookupTrain('14074'), { reason: 'rate_limited' });
  assert.equal(calls.length, 2);
  const status = irctc.requestBudgetStatus();
  assert.equal(status.resetDateMismatch, true, 'the mismatch with RapidAPI\'s reset time is reported');
});

test('a count made before a reset date was configured is carried over, not dropped', async (t) => {
  process.env.TRAIN_API_REQUEST_BUDGET = '3';
  respond = (url) => irctcTrain(url.split('/').pop());
  at('2026-10-20T08:00:00Z', t);
  await irctc.lookupTrain('14081');
  await irctc.lookupTrain('14082');
  process.env.TRAIN_API_QUOTA_RESET_DATE = '2026-09-14';
  await irctc.lookupTrain('14083');
  await assert.rejects(irctc.lookupTrain('14084'), { reason: 'budget_exhausted' });
  assert.equal(savedUsage().period.startedBy, 'carried_over');
  assert.equal(savedUsage().requestsSent, 3);
});

test('with a reset date configured, the manual reset is refused', () => {
  process.env.TRAIN_API_QUOTA_RESET_DATE = '2026-09-14';
  assert.throws(() => irctc.startNewBudgetPeriod({ confirm: true }), /TRAIN_API_QUOTA_RESET_DATE is set/);
  const env = { ...process.env };
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts/irctc-usage.js'), '--reset', '--confirm'], { env, stdio: 'pipe' }),
    (err) => err.status === 1 && /manual reset is not allowed/.test(err.stderr.toString()));
});

test('the usage command shows the configured period without writing anything', () => {
  const env = { ...process.env, TRAIN_API_QUOTA_RESET_DATE: '2026-09-14', TRAIN_API_REQUEST_BUDGET: '0' };
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/irctc-usage.js')], { env, encoding: 'utf8' });
  assert.match(out, /Quota period: +\d{4}-\d{2}-14T00:00:00\.000Z to \d{4}-\d{2}-14T00:00:00\.000Z/);
  assert.match(out, /Live requests: +OFF/);
  assert.ok(!fs.existsSync(USAGE_FILE));
});
