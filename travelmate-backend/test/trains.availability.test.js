// Seat availability is never invented: the backend labels every non-live
// class "Check seats on IRCTC", says why a live lookup gave nothing, and the
// TravelMate.html class pills send each train's own stations. Offline: axios is
// stubbed, and the class-availability provider call makes no request.

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');
const { startServer } = require('./helpers/server');

const ROOT = path.join(__dirname, '..');
const {
  IRCTC_SEAT_CHECK_URL, SEAT_CHECK_STATUS, REASONS, withSeatCheck, availabilityReason
} = require(path.join(ROOT, 'src/utils/seatAvailability'));

const SEARCHED = '?trainNumber=12649&classType=SL&from=YPR&to=KCG&date=2026-10-30';

// --- utils/seatAvailability -------------------------------------------------

test('withSeatCheck: a non-live class loses its seat status, keeps its fare', () => {
  const out = withSeatCheck([
    { cls: '3A', fare: 2190, status: 'RAC 8', tier: 'rac' },
    { cls: 'SL', fare: 605, status: 'Check availability', tier: 'available', live: false },
    { cls: '2A', fare: 3080, status: 'Available', tier: 'available', live: true }
  ]);
  assert.deepEqual(out, [
    { cls: '3A', fare: 2190, status: SEAT_CHECK_STATUS, tier: 'unknown', live: false },
    { cls: 'SL', fare: 605, status: SEAT_CHECK_STATUS, tier: 'unknown', live: false },
    { cls: '2A', fare: 3080, status: 'Available', tier: 'available', live: true }
  ]);
  assert.equal(SEAT_CHECK_STATUS, 'Check seats on IRCTC');
});

test('withSeatCheck: passes through a missing class list', () => {
  assert.equal(withSeatCheck(undefined), undefined);
});

test('availabilityReason maps provider errors to reason codes', () => {
  assert.equal(availabilityReason({ status: 501 }), REASONS.NOT_SUPPORTED);
  assert.equal(availabilityReason({ status: 429, rateLimited: true }), REASONS.RATE_LIMITED);
  assert.equal(availabilityReason({ status: 502 }), REASONS.PROVIDER_ERROR);
  assert.equal(availabilityReason(undefined), REASONS.PROVIDER_ERROR);
});

// --- GET /api/trains/class-availability, through the real server ------------

let keyless;
let keyed;
before(async () => {
  // A fake key only: the seat-availability provider call is unsupported and
  // throws before any request, so nothing reaches RapidAPI.
  [keyless, keyed] = await Promise.all([startServer(), startServer({ env: { RAPIDAPI_KEY: 'fake-rapidapi-key-for-seat-test' } })]);
});
after(() => Promise.all([keyless.stop(), keyed.stop()]));

test('class-availability: 12649 SL YPR->KCG on 2026-10-30 is "not_supported", not "no seats"', async () => {
  const { status, body } = await keyed.get(`/api/trains/class-availability${SEARCHED}`);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    live: false,
    cls: 'SL',
    reason: 'not_supported',
    message: 'Live seat availability is not offered by the current train API — check IRCTC for the latest status.',
    checkUrl: IRCTC_SEAT_CHECK_URL
  });
});

test('class-availability: without a key the reason is "not_configured"', async () => {
  const { status, body } = await keyless.get(`/api/trains/class-availability${SEARCHED}`);
  assert.equal(status, 200);
  assert.equal(body.live, false);
  assert.equal(body.reason, 'not_configured');
  assert.equal(body.checkUrl, IRCTC_SEAT_CHECK_URL);
});

test('class-availability: the response never contains the key', async () => {
  const { text } = await keyed.get(`/api/trains/class-availability${SEARCHED}`);
  assert.ok(!text.includes('fake-rapidapi-key-for-seat-test'));
});

test('class-availability: missing parameters are still a 400', async () => {
  const { status, body } = await keyed.get('/api/trains/class-availability?trainNumber=12649&classType=SL&from=YPR&to=KCG');
  assert.equal(status, 400);
  assert.equal(body.error.message, 'trainNumber, classType, from, to, and date are all required.');
});

// --- GET /api/trains/search, in-process with every outside call failing ------
// erail is "unreachable" (axios stubbed) and there is no RapidAPI key, so the
// route falls back to data/knownTrainRoutes.js — hand-entered classes that
// carry statuses like "Available" and "WL 3", which must not reach a client.

const realGet = axios.get;
let savedKey;
beforeEach(() => {
  axios.get = async () => { throw new Error('offline in tests'); };
  savedKey = process.env.RAPIDAPI_KEY;
  delete process.env.RAPIDAPI_KEY;
});
afterEach(() => {
  axios.get = realGet;
  if (savedKey !== undefined) process.env.RAPIDAPI_KEY = savedKey;
});

async function searchInProcess(query) {
  const app = express();
  app.use('/api/trains', require(path.join(ROOT, 'src/routes/trains.routes')));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/trains/search${query}`);
    return { status: res.status, body: await res.json() };
  } finally {
    srv.close();
  }
}

test('search: hand-entered seat statuses never reach the client', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { status, body } = await searchInProcess('?from=YPR&to=KCG&date=2026-10-30');
  assert.equal(status, 200);
  assert.equal(body.meta.source, 'verified');
  assert.ok(body.results.length > 0, 'expected the verified YPR->KCG trains');
  for (const train of body.results) {
    for (const c of train.classes) {
      assert.equal(c.live, false, `${train.trainNumber} ${c.cls}`);
      assert.equal(c.status, SEAT_CHECK_STATUS, `${train.trainNumber} ${c.cls}`);
      assert.equal(c.tier, 'unknown', `${train.trainNumber} ${c.cls}`);
      assert.ok(Number.isFinite(c.fare), 'the fare is kept');
    }
  }
});

test('search: meta says seat availability is not live and where to check it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { body } = await searchInProcess('?from=KCG&to=YPR&date=2026-10-31');
  assert.deepEqual(body.meta.seatAvailability, { live: false, reason: 'not_supported', checkUrl: IRCTC_SEAT_CHECK_URL });
});

// --- TravelMate.html: the real functions, run in a sandbox --------------------

const HTML = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');

// The source of one top-level declaration, matched up to its closing brace.
function declaration(startPattern) {
  const start = HTML.search(startPattern);
  assert.ok(start >= 0, `not found in TravelMate.html: ${startPattern}`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, HTML[i + 1] === ';' ? i + 2 : i + 1);
  }
  throw new Error(`unterminated: ${startPattern}`);
}

function loadFrontend(extra = {}) {
  const context = vm.createContext({ setTimeout: () => {}, URLSearchParams, lastTrainSearchMeta: null, ...extra });
  vm.runInContext([
    /const IRCTC_TRAIN_SEARCH_URL = '[^']+';/.exec(HTML)[0],
    declaration(/function irctcSeatLinkHtml\(/),
    declaration(/function trainCardStationCodes\(/),
    declaration(/const SEAT_REFRESH_REASON_LABELS = \{/),
    declaration(/async function refreshClassFare\(/),
    'this.api = { IRCTC_TRAIN_SEARCH_URL, irctcSeatLinkHtml, trainCardStationCodes, refreshClassFare };'
  ].join('\n'), context);
  return context;
}

// A class pill with a refresh button, as far as refreshClassFare touches them.
function fakePill(dataset) {
  const pill = { dataset, querySelector: () => null, inserted: '' };
  const btn = {
    textContent: '⟳ Refresh', title: '', disabled: false, removed: false,
    classList: { add() {}, remove() {} },
    closest: () => pill,
    insertAdjacentHTML(where, html) { pill.inserted += html; },
    remove() { this.removed = true; }
  };
  return { pill, btn };
}

test('TravelMate: a card uses its train\'s own stations, not the searched ones', () => {
  const { api } = loadFrontend();
  const searched = { from: 'SBC', to: 'HYB', date: '2026-10-30' }; // a Bengaluru -> Hyderabad city search
  assert.deepEqual(
    { ...api.trainCardStationCodes({ fromStation: 'Yesvantpur Junction (YPR)', toStation: 'Kacheguda (KCG)' }, searched) },
    { from: 'YPR', to: 'KCG' });
  // The offline demo dataset has no codes in its labels: the searched ones are used
  assert.deepEqual({ ...api.trainCardStationCodes({ fromStation: 'New Delhi', toStation: 'Mumbai Central' }, searched) }, { from: 'SBC', to: 'HYB' });
});

test('TravelMate: refresh sends the pill\'s own train, class, stations and date', async () => {
  const requests = [];
  const fetch = async (url) => { requests.push(url); return { json: async () => ({ live: false, cls: 'SL', reason: 'not_supported', message: 'not offered' }) }; };
  const { api } = loadFrontend({ fetch, lastTrainSearchMeta: { from: 'SBC', to: 'HYB', date: '2026-10-29' } });
  const { btn } = fakePill({ train: '12649', class: 'SL', from: 'YPR', to: 'KCG', date: '2026-10-30' });
  await api.refreshClassFare(btn);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0]);
  assert.equal(url.pathname, '/api/trains/class-availability');
  assert.deepEqual(Object.fromEntries(url.searchParams), { trainNumber: '12649', classType: 'SL', from: 'YPR', to: 'KCG', date: '2026-10-30' });
});

test('TravelMate: "not_supported" swaps the button for "Check seats on IRCTC", never "Unavailable"', async () => {
  const fetch = async () => ({ json: async () => ({ live: false, cls: 'SL', reason: 'not_supported', message: 'Live seat availability is not offered' }) });
  const { api } = loadFrontend({ fetch });
  const { pill, btn } = fakePill({ train: '12649', class: 'SL', from: 'YPR', to: 'KCG', date: '2026-10-30' });
  await api.refreshClassFare(btn);
  assert.equal(btn.removed, true);
  assert.match(pill.inserted, /Check seats on IRCTC/);
  assert.ok(pill.inserted.includes(`href="${api.IRCTC_TRAIN_SEARCH_URL}"`));
  assert.ok(!/Unavailable/i.test(btn.textContent + pill.inserted));
});

test('TravelMate: other non-live reasons get an honest label, not "Unavailable"', async () => {
  const labels = { rate_limited: 'Try again later', not_configured: 'Live check off', no_data: 'No live data', provider_error: 'Check failed' };
  for (const [reason, label] of Object.entries(labels)) {
    const fetch = async () => ({ json: async () => ({ live: false, reason, message: `msg for ${reason}` }) });
    const { api } = loadFrontend({ fetch });
    const { btn } = fakePill({ train: '12649', class: 'SL', from: 'YPR', to: 'KCG', date: '2026-10-30' });
    await api.refreshClassFare(btn);
    assert.equal(btn.textContent, label, reason);
    assert.equal(btn.title, `msg for ${reason}`, reason);
  }
});

test('TravelMate: an unreadable response is "Check failed"', async () => {
  const fetch = async () => ({ json: async () => { throw new Error('not json'); } });
  const { api } = loadFrontend({ fetch });
  const { btn } = fakePill({ train: '12649', class: 'SL', from: 'YPR', to: 'KCG', date: '2026-10-30' });
  await api.refreshClassFare(btn);
  assert.equal(btn.textContent, 'Check failed');
});

test('TravelMate: class pills carry their stations and date, and non-live ones link to IRCTC', () => {
  const pill = /<div class="class-pill"[^>]*>[\s\S]*?<\/div>\s*`\)\.join/.exec(HTML);
  assert.ok(pill, 'class pill template not found');
  assert.match(pill[0], /data-from="\$\{codes\.from\}" data-to="\$\{codes\.to\}" data-date="\$\{journeyDate \|\| ''\}"/);
  assert.match(pill[0], /c\.live === true\s*\?/);
  assert.match(pill[0], /: irctcSeatLinkHtml\(\)/);
});

test('TravelMate: no "Unavailable" or "Check availability" wording is left', () => {
  assert.ok(!/Unavailable/.test(HTML), '"Unavailable" found');
  assert.ok(!/check availability/i.test(HTML), '"Check availability" found');
});
