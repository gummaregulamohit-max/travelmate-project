// Live Indian Railways train data via the "Indian Railway IRCTC" API on
// RapidAPI (https://rapidapi.com/rahilkhan224/api/indian-railway-irctc) —
// the primary train data provider. Requires RAPIDAPI_KEY in .env — see
// .env.example.
//
// Endpoint used (host and response shape confirmed with live requests):
//   GET https://indian-railway-irctc.p.rapidapi.com/api/trains-search/v1/train/{trainNo}?isH5=true&client=web
//   -> { body: [{ trains: [{ trainNumber, trainName, stationFrom, stationTo,
//        runningOn: "NNYNYNN" (Sun..Sat at the origin), journeyClasses,
//        schedule: [{ stationCode, stationName, arrivalTime, departureTime,
//        haltTime "MM:SS", distance, dayCount, routeNumber }] }] }] }
// It has no "trains between stations" or fare/seat-availability endpoint,
// so a route search is built in two steps:
//   1. The candidate trains for the route come from the public timetable
//      (erail.service.js), with its fare-chart prices.
//   2. Up to MAX_LOOKUPS_PER_SEARCH of them are verified against IRCTC,
//      replacing the timings and running days with IRCTC's own at the
//      searched stations (and dropping trains IRCTC says don't run that day).
//
// Quota safety — the free BASIC plan allows 50 requests a month (hard limit):
//   - Every request goes through lookupTrain(): cache first, then any request
//     already in flight for the same train (shared, never repeated), then the
//     request gate, then exactly one attempt. Nothing is ever retried — not an
//     empty answer, a 403, a 429 or a network error.
//   - TRAIN_API_REQUEST_BUDGET caps how many requests this server may ever
//     send. Unset / 0 (the default) means live requests are OFF. Requests
//     sent are counted in TRAIN_API_USAGE_FILE before they are sent, under a
//     cross-process lock (several backend processes can share one budget).
//     The count restarts only when a configured TRAIN_API_QUOTA_RESET_DATE
//     period ends, or — when none is configured — by an explicit, confirmed
//     manual reset (npm run irctc:usage -- --reset --confirm). Neither is
//     taken as proof RapidAPI's quota renewed.
//   - A 429 (quota used up) or 403 (key not subscribed) blocks all requests
//     until RapidAPI's reset time (or BLOCK_FALLBACK_MS), and so does a
//     response saying 0 requests remain. Both are kept in the usage file, so
//     a restart does not lift them.
// Each train's details are cached for DETAILS_TTL_MS (an empty answer for
// EMPTY_TTL_MS) with the time IRCTC actually answered (respondedAt), so data
// served again from cache is reported as cached, not live.

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'indian-railway-irctc.p.rapidapi.com';
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const REQUEST_TIMEOUT_MS = 12000;

// How many new IRCTC requests one route search may send, from
// TRAIN_API_MAX_LOOKUPS_PER_SEARCH (TRAIN_API_REQUEST_BUDGET still applies):
//   unset / blank        -> DEFAULT_LOOKUPS_PER_SEARCH
//   0                    -> none: searches use the timetable plus any IRCTC
//                           details already cached (schedule pop-ups may
//                           still send one request each, within the budget)
//   1..MAX_LOOKUPS_LIMIT -> that many
//   above the limit      -> MAX_LOOKUPS_LIMIT, with a warning
//   anything else        -> DEFAULT_LOOKUPS_PER_SEARCH, with a warning
const DEFAULT_LOOKUPS_PER_SEARCH = 3;
const MAX_LOOKUPS_LIMIT = 10;

function parseMaxLookups(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return DEFAULT_LOOKUPS_PER_SEARCH;
  if (!/^\d+$/.test(text)) {
    console.warn(`[trains] TRAIN_API_MAX_LOOKUPS_PER_SEARCH="${text}" is not a whole number — using ${DEFAULT_LOOKUPS_PER_SEARCH}.`);
    return DEFAULT_LOOKUPS_PER_SEARCH;
  }
  const value = parseInt(text, 10);
  if (value > MAX_LOOKUPS_LIMIT) {
    console.warn(`[trains] TRAIN_API_MAX_LOOKUPS_PER_SEARCH=${value} is above ${MAX_LOOKUPS_LIMIT} — using ${MAX_LOOKUPS_LIMIT} to protect the monthly quota.`);
    return MAX_LOOKUPS_LIMIT;
  }
  return value;
}

// TRAIN_API_REQUEST_BUDGET: unset / blank / 0 -> live requests off; a whole
// number -> at most that many requests in total (see the usage file); anything
// else -> off, with a warning.
const warnedBudgets = new Set();
function parseRequestBudget(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return 0;
  if (!/^\d+$/.test(text)) {
    if (!warnedBudgets.has(text)) console.warn(`[trains] TRAIN_API_REQUEST_BUDGET="${text}" is not a whole number — live IRCTC requests stay off.`);
    warnedBudgets.add(text);
    return 0;
  }
  return parseInt(text, 10);
}

const MAX_LOOKUPS_PER_SEARCH = parseMaxLookups(process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH);
const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 60 * 60 * 1000;
const detailsCache = new Map(); // trainNumber -> { details, respondedAt, cachedAt, expiresAt }
const inFlight = new Map(); // trainNumber -> Promise of the one request being sent

// How long requests stay blocked when RapidAPI gives no reset time.
const BLOCK_FALLBACK_MS = { rate_limited: 24 * 60 * 60 * 1000, not_subscribed: 60 * 60 * 1000 };

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Why IRCTC data is missing, and the text shown for it. Fixed strings only —
// provider messages and keys never reach a response.
const REASON_MESSAGES = {
  not_configured: 'Live IRCTC checks are not configured on this server.',
  disabled: 'Live IRCTC requests are switched off on this server (TRAIN_API_REQUEST_BUDGET).',
  budget_exhausted: 'This server has used its IRCTC request budget, so no new IRCTC requests are sent.',
  rate_limited: 'The IRCTC (RapidAPI) plan has used up its request quota for now.',
  not_subscribed: 'This server\'s RapidAPI key is not subscribed to the Indian Railway IRCTC API.',
  failed: 'The IRCTC (RapidAPI) request failed.',
  usage_locked: 'Could not safely reserve an IRCTC request right now (the request count is busy), so none was sent.',
  not_supported: 'Live seat availability is not offered by the current train API — check IRCTC for the latest status.'
};

class IrctcApiError extends Error {
  constructor(message, status, details, reason) {
    super(message);
    this.name = 'IrctcApiError';
    this.status = status || 502;
    this.reason = reason || (status === 429 ? 'rate_limited' : status === 403 ? 'not_subscribed' : 'failed');
    this.rateLimited = this.reason === 'rate_limited';
    this.notSubscribed = this.reason === 'not_subscribed';
    this.publicMessage = REASON_MESSAGES[this.reason] || REASON_MESSAGES.failed;
    this.details = details;
  }
}

// --- persisted usage: requests sent, provider quota headers, active block ----
//
// One usage file may be shared by several backend processes, so every
// read-check-write of it happens under a cross-process lock: a lock file
// created with O_EXCL ('wx' — atomic: exactly one process can create it),
// removed when done. The check that a request is allowed and the count of it
// happen in the same locked step (reserveRequest), so two processes can never
// both spend the last request. Writes go to a per-process temp file renamed
// over the usage file (atomic), so a reader never sees half a file.
//
// A lock left behind by a crashed process is broken when its owner process is
// gone (same host) or it is older than LOCK_STALE_MS. A process that can't get
// the lock within TRAIN_API_LOCK_TIMEOUT_MS sends no request (usage_locked).

const DEFAULT_USAGE_FILE = path.join(__dirname, '..', '..', '.cache', 'irctc-usage.json');
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30 * 1000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
// A 403/429 seen by this process, kept in memory too in case recording it in
// the usage file fails — so this process never sends again regardless.
let memoryBlock = null;

function usageFile() {
  return process.env.TRAIN_API_USAGE_FILE || DEFAULT_USAGE_FILE;
}

function lockTimeoutMs() {
  const value = parseInt(process.env.TRAIN_API_LOCK_TIMEOUT_MS, 10);
  return value > 0 ? value : DEFAULT_LOCK_TIMEOUT_MS;
}

// Wall-clock milliseconds that ignore a mocked Date.now (lock ages, timeouts).
function realNow() {
  return performance.timeOrigin + performance.now();
}

function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Removes a lock whose owner is gone or that is too old; true when removed.
// It is renamed away first (atomic — only one process can win), and put back
// if what was renamed turns out to be a fresh lock taken in the meantime.
function breakStaleLock(lock) {
  let owner;
  let ageMs;
  try {
    owner = fs.readFileSync(lock, 'utf8');
    ageMs = realNow() - fs.statSync(lock).mtimeMs;
  } catch (err) {
    return err.code === 'ENOENT';
  }
  let info = null;
  try { info = JSON.parse(owner); } catch { /* half-written: judged by age only */ }
  const ownerGone = info && info.host === os.hostname() && info.pid !== process.pid && !processAlive(info.pid);
  if (!ownerGone && ageMs < LOCK_STALE_MS) return false;

  const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lock, aside);
  } catch (err) {
    return err.code === 'ENOENT';
  }
  if (fs.readFileSync(aside, 'utf8') !== owner) {
    try { fs.linkSync(aside, lock); } catch { /* someone holds a newer lock already */ }
  } else {
    console.warn(`[trains] Removed a stale IRCTC usage lock (${ownerGone ? `process ${info.pid} is gone` : `${Math.round(ageMs / 1000)}s old`}).`);
  }
  fs.rmSync(aside, { force: true });
  return true;
}

function withUsageLock(fn) {
  const file = usageFile();
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = realNow() + lockTimeoutMs();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(realNow()).toISOString() })); } finally { fs.closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (breakStaleLock(lock)) continue;
      if (realNow() > deadline) {
        throw new IrctcApiError(REASON_MESSAGES.usage_locked, 503, null, 'usage_locked');
      }
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// The usage record as saved on disk (callers hold the lock to change it). A
// file that exists but can't be read marks the record unreadable, which keeps
// live requests off rather than starting the count again from zero.
function loadUsage() {
  let saved = {};
  let unreadable = false;
  try {
    saved = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
  } catch (err) {
    unreadable = err.code !== 'ENOENT';
    if (unreadable) console.warn(`[trains] Could not read ${usageFile()} (${err.message}) — live IRCTC requests stay off until it is fixed.`);
  }
  return {
    requestsSent: Number.isInteger(saved.requestsSent) && saved.requestsSent >= 0 ? saved.requestsSent : 0,
    lastRequestAt: saved.lastRequestAt || null,
    provider: saved.provider || null, // { remaining, limit, resetAt, observedAt } from RapidAPI's headers
    block: saved.block || null, // { reason, status, until, since }
    // { startedAt, startedBy: 'manual' | 'configured_reset_date' | 'carried_over', configuredStart? }
    period: saved.period || null,
    history: Array.isArray(saved.history) ? saved.history : [], // earlier periods' counts, never discarded
    unreadable
  };
}

function saveUsage(u) {
  const { unreadable, ...record } = u;
  const file = usageFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  // Windows can refuse a rename for a moment while another process reads the
  // file; this is a local file operation, never an API retry.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= 20) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(10);
    }
  }
}

// --- budget periods ------------------------------------------------------------
//
// TRAIN_API_QUOTA_RESET_DATE: when your RapidAPI quota period starts, as shown
// on the RapidAPI dashboard — e.g. 2026-10-14 or 2026-10-14T05:30:00Z (UTC).
// Periods then run monthly from that date (a 31st becomes the last day of
// shorter months). When a period ends, TravelMate's local count starts again
// at 0 — that only restarts TravelMate's own count: a 403/429 block or
// RapidAPI's "0 requests left" still holds until RapidAPI's own reset time.
// Unset: there are no periods; the count only restarts by a confirmed manual
// reset (npm run irctc:usage -- --reset --confirm).

const warnedResetDates = new Set();
function quotaResetAnchor() {
  const text = String(process.env.TRAIN_API_QUOTA_RESET_DATE || '').trim();
  if (!text) return null;
  const match = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z)?$/.exec(text);
  const anchor = match ? new Date(match[1] ? text : `${text}T00:00:00Z`) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) {
    if (!warnedResetDates.has(text)) console.warn(`[trains] TRAIN_API_QUOTA_RESET_DATE="${text}" is not a date like 2026-10-14 or 2026-10-14T05:30:00Z — no automatic budget periods.`);
    warnedResetDates.add(text);
    return null;
  }
  return anchor;
}

// `anchor` moved by `months`, keeping its day where the month has it.
function addMonthsUTC(anchor, months) {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor.getUTCDate(), lastDay),
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

// { start, end } of the configured period containing `nowMs`, or null.
function configuredPeriod(nowMs = Date.now()) {
  const anchor = quotaResetAnchor();
  if (!anchor) return null;
  const now = new Date(nowMs);
  let k = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (addMonthsUTC(anchor, k).getTime() > nowMs) k -= 1;
  while (addMonthsUTC(anchor, k + 1).getTime() <= nowMs) k += 1;
  return { start: addMonthsUTC(anchor, k).toISOString(), end: addMonthsUTC(anchor, k + 1).toISOString() };
}

// Moves `u` into the configured period containing now. A count with no known
// period is kept (it may belong to this one); a count from an earlier period
// is archived and the new period starts at 0. Returns true when `u` changed.
function rollConfiguredPeriod(u) {
  const current = configuredPeriod();
  if (!current) return false;
  const known = u.period && u.period.configuredStart;
  if (!known) {
    u.period = { ...(u.period || { startedAt: current.start }), startedBy: (u.period && u.period.startedBy) || 'carried_over', configuredStart: current.start };
    return true;
  }
  if (Date.parse(current.start) <= Date.parse(known)) return false;
  u.history = [...u.history, { requestsSent: u.requestsSent, startedAt: u.period.startedAt, endedAt: current.start, endedBy: 'configured_reset_date', lastRequestAt: u.lastRequestAt }];
  u.requestsSent = 0;
  u.period = { startedAt: current.start, startedBy: 'configured_reset_date', configuredStart: current.start };
  return true;
}

/**
 * Manual, explicit start of a new local budget period: archives the current
 * count in `history` and starts counting from 0. Only when no
 * TRAIN_API_QUOTA_RESET_DATE is configured (then periods follow that date).
 * It only resets TravelMate's own count — it is not evidence that RapidAPI's
 * quota has renewed, so an active 403/429 block and RapidAPI's last
 * "0 remaining" report stay in force until their own reset times. Refused
 * without confirm: true, and when the usage file can't be read.
 */
function startNewBudgetPeriod({ confirm = false, note = '' } = {}) {
  if (confirm !== true) throw new Error('Refusing to reset the IRCTC request count without explicit confirmation.');
  if (quotaResetAnchor()) {
    throw new Error('TRAIN_API_QUOTA_RESET_DATE is set, so the local count restarts on that date each period — a manual reset is not allowed.');
  }
  withUsageLock(() => {
    const u = loadUsage();
    if (u.unreadable) throw new Error(`${usageFile()} can't be read — fix or remove it by hand first.`);
    const now = new Date(Date.now()).toISOString();
    u.history = [...u.history, { requestsSent: u.requestsSent, startedAt: u.period ? u.period.startedAt : null, endedAt: now, endedBy: 'manual', lastRequestAt: u.lastRequestAt }];
    u.requestsSent = 0;
    u.period = { startedAt: now, startedBy: 'manual', ...(note ? { note: String(note).slice(0, 200) } : {}) };
    saveUsage(u);
  });
  return requestBudgetStatus();
}

function providerExhaustedUntil(u) {
  if (!u.provider || u.provider.remaining !== 0) return null;
  return u.provider.resetAt || new Date(Date.parse(u.provider.observedAt) + BLOCK_FALLBACK_MS.rate_limited).toISOString();
}

/**
 * Checks that one new request may be sent and, in the same locked step,
 * counts it — or throws the reason it may not (nothing is counted then).
 * Off unless RAPIDAPI_KEY is set and TRAIN_API_REQUEST_BUDGET is above 0;
 * those two are checked first, without touching the usage file.
 */
function reserveRequest() {
  if (!process.env.RAPIDAPI_KEY) {
    throw new IrctcApiError(REASON_MESSAGES.not_configured, 500, null, 'not_configured');
  }
  const budget = parseRequestBudget(process.env.TRAIN_API_REQUEST_BUDGET);
  if (budget === 0) throw new IrctcApiError(REASON_MESSAGES.disabled, 503, null, 'disabled');
  const now = Date.now();
  if (memoryBlock && now < Date.parse(memoryBlock.until)) {
    throw new IrctcApiError(`${REASON_MESSAGES[memoryBlock.reason]} No requests until ${memoryBlock.until}.`, memoryBlock.status, null, memoryBlock.reason);
  }
  withUsageLock(() => {
    const u = loadUsage();
    if (u.unreadable) throw new IrctcApiError(REASON_MESSAGES.disabled, 503, null, 'disabled');
    const rolled = rollConfiguredPeriod(u);
    if (u.block && now < Date.parse(u.block.until)) {
      throw new IrctcApiError(`${REASON_MESSAGES[u.block.reason] || REASON_MESSAGES.failed} No requests until ${u.block.until}.`, u.block.status, null, u.block.reason);
    }
    // RapidAPI's own counter said nothing is left: wait for its reset time (or
    // the 429 fallback when it gave none). No local reset or new local period
    // lifts this.
    const exhaustedUntil = providerExhaustedUntil(u);
    if (exhaustedUntil && now < Date.parse(exhaustedUntil)) {
      throw new IrctcApiError(`${REASON_MESSAGES.rate_limited} No requests until ${exhaustedUntil}.`, 429, null, 'rate_limited');
    }
    if (u.requestsSent >= budget) {
      if (rolled) saveUsage(u);
      throw new IrctcApiError(`${REASON_MESSAGES.budget_exhausted} (${u.requestsSent} of ${budget} sent)`, 503, null, 'budget_exhausted');
    }
    u.requestsSent += 1;
    u.lastRequestAt = new Date(now).toISOString();
    saveUsage(u);
  });
}

// RapidAPI's quota headers, as reported — never estimated.
function recordProviderQuota(responseHeaders) {
  const remaining = parseInt(responseHeaders?.['x-ratelimit-requests-remaining'], 10);
  if (Number.isNaN(remaining)) return;
  const limit = parseInt(responseHeaders['x-ratelimit-requests-limit'], 10);
  const reset = parseInt(responseHeaders['x-ratelimit-requests-reset'], 10);
  const provider = {
    remaining,
    limit: Number.isNaN(limit) ? null : limit,
    resetAt: reset > 0 ? new Date(Date.now() + reset * 1000).toISOString() : null,
    observedAt: new Date(Date.now()).toISOString()
  };
  if (remaining === 0) memoryBlock = { reason: 'rate_limited', status: 429, until: providerExhaustedUntil({ provider }) };
  try {
    withUsageLock(() => {
      const u = loadUsage();
      if (u.unreadable) return;
      u.provider = provider;
      saveUsage(u);
    });
  } catch (err) {
    console.warn(`[trains] Could not record RapidAPI's quota headers: ${err.message}`);
  }
  console.log(`[trains] Indian Railway IRCTC API: ${remaining} requests left this period (RapidAPI).`);
}

function blockRequests(error, responseHeaders) {
  const reset = parseInt(responseHeaders?.['x-ratelimit-requests-reset'], 10);
  const until = new Date(Date.now() + (reset > 0 ? reset * 1000 : BLOCK_FALLBACK_MS[error.reason])).toISOString();
  const block = { reason: error.reason, status: error.status, until, since: new Date(Date.now()).toISOString() };
  memoryBlock = block;
  try {
    withUsageLock(() => {
      const u = loadUsage();
      if (u.unreadable) return;
      u.block = block;
      saveUsage(u);
    });
  } catch (err) {
    console.warn(`[trains] Could not record the IRCTC block in the usage file (this process stays blocked): ${err.message}`);
  }
  console.warn(`[trains] ${error.publicMessage} No IRCTC requests until ${until}.`);
}

/** What may still be sent, for the startup log and npm run irctc:usage — sends nothing, writes nothing. */
function requestBudgetStatus() {
  const u = loadUsage();
  rollConfiguredPeriod(u); // the view only — saved on the next request
  const budget = parseRequestBudget(process.env.TRAIN_API_REQUEST_BUDGET);
  const exhaustedUntil = providerExhaustedUntil(u);
  const blockedUntil = u.block && Date.now() < Date.parse(u.block.until) ? u.block.until
    : exhaustedUntil && Date.now() < Date.parse(exhaustedUntil) ? exhaustedUntil : null;
  const blockReason = !blockedUntil ? null : blockedUntil === (u.block && u.block.until) ? u.block.reason : 'rate_limited';
  const configured = configuredPeriod();
  // RapidAPI's reported reset time vs. the configured date: a gap of more
  // than a day means TRAIN_API_QUOTA_RESET_DATE probably doesn't match.
  const providerReset = u.provider && u.provider.resetAt;
  const resetDateMismatch = Boolean(configured && providerReset && Date.parse(providerReset) > Date.now()
    && Math.abs(Date.parse(providerReset) - Date.parse(configured.end)) > 24 * 60 * 60 * 1000);
  return {
    enabled: budget > 0 && !u.unreadable, budget, requestsSent: u.requestsSent, unreadable: u.unreadable,
    provider: u.provider, blockedUntil, blockReason, period: u.period, earlierPeriods: u.history.length,
    configuredPeriod: configured, resetDateMismatch, file: usageFile()
  };
}

/** Test hook: forget the in-memory train cache, in-flight requests and this process's block (the usage file is untouched). */
function resetStateForTests() {
  detailsCache.clear();
  inFlight.clear();
  memoryBlock = null;
}

function headers() {
  return { 'x-rapidapi-key': process.env.RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapid-api': 'rapid-api-database' };
}

function asIrctcError(err, fallbackMessage) {
  if (err instanceof IrctcApiError) return err;
  const status = err.response?.status || 502;
  const apiMessage = err.response?.data?.message || err.response?.data?.error;
  return new IrctcApiError(apiMessage || fallbackMessage, status, err.response?.data ?? err.message);
}

function deriveTrainType(trainName) {
  const name = (trainName || '').toLowerCase();
  if (name.includes('vande bharat')) return 'Vande Bharat';
  if (name.includes('rajdhani')) return 'Rajdhani';
  if (name.includes('shatabdi')) return 'Shatabdi';
  if (name.includes('duronto')) return 'Duronto';
  if (name.includes('garib rath')) return 'Garib Rath';
  if (name.includes('humsafar')) return 'Humsafar';
  if (name.includes('tejas')) return 'Tejas';
  if (name.includes('superfast') || / sf /.test(name)) return 'Superfast';
  if (name.includes('mail')) return 'Mail';
  if (name.includes('special') || name.includes('spl')) return 'Special';
  if (name.includes('passenger')) return 'Passenger';
  return 'Express';
}

// `runs`: 7 booleans, Sunday first (Date#getUTCDay order).
function describeDays(runs) {
  if (!Array.isArray(runs) || runs.length !== 7 || runs.every(Boolean) || !runs.some(Boolean)) return 'Runs Daily';
  return `Runs on ${DAY_LABELS.filter((_, i) => runs[i]).join(', ')}`;
}

// IRCTC's runningOn ("NNYNYNN", Sun..Sat, at the origin) shifted to a stop
// reached on day `dayCount` of the journey. null when runningOn is malformed.
function runningDaysAt(runningOn, dayCount) {
  if (!/^[YN]{7}$/.test(runningOn || '')) return null;
  const shift = (parseInt(dayCount, 10) || 1) - 1;
  return Array.from({ length: 7 }, (_, i) => runningOn[(((i - shift) % 7) + 7) % 7] === 'Y');
}

// "09:15" -> minutes after midnight; "--" (no arrival/departure) -> null
function clockMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})/.exec(raw || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function hhmm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// "Smvt Bengaluru (SMVB)" or a bare "SMVB" -> "SMVB"
function codeFromLabel(label) {
  const m = /\(([A-Z0-9]+)\)\s*$/.exec(label || '');
  return m ? m[1] : String(label || '').trim().toUpperCase();
}

// The one request for a train (already counted by reserveRequest), attempted
// once — no retry of any kind — and its answer (a train, or null for an empty
// answer) cached with the time IRCTC answered.
async function requestTrainDetails(trainNumber) {
  try {
    const response = await axios.get(`${BASE_URL}/api/trains-search/v1/train/${encodeURIComponent(trainNumber)}`, {
      params: { isH5: true, client: 'web' },
      headers: headers(),
      timeout: REQUEST_TIMEOUT_MS
    });
    const respondedAt = new Date(Date.now()).toISOString();
    recordProviderQuota(response.headers);
    const train = response.data?.body?.[0]?.trains?.[0];
    const details = train && Array.isArray(train.schedule) && train.schedule.length ? train : null;
    if (!details) console.warn(`[trains] Indian Railway IRCTC API returned no train for ${trainNumber} (not retried).`);
    detailsCache.set(trainNumber, { details, respondedAt, cachedAt: new Date(Date.now()).toISOString(), expiresAt: Date.now() + (details ? DETAILS_TTL_MS : EMPTY_TTL_MS) });
    return { details, respondedAt };
  } catch (err) {
    const error = asIrctcError(err, `Failed to fetch train ${trainNumber} from the live IRCTC API.`);
    if (error.rateLimited || error.notSubscribed) blockRequests(error, err.response?.headers);
    throw error;
  }
}

/**
 * IRCTC details for one train, sending at most one request for it at a time:
 *   { details, respondedAt, cachedAt, cached: true }   from the cache
 *   { details, respondedAt, cached: false, requested } from a live answer —
 *       this call's own request (requested: true) or one already in flight
 *   { skipped: true }                                  not cached and allowRequest is false
 * `details` is null when IRCTC answered with no train. Throws an IrctcApiError
 * (with `reason`) when no request may be sent or the request failed.
 */
async function lookupTrain(trainNumber, { allowRequest = true } = {}) {
  const cached = detailsCache.get(trainNumber);
  if (cached && Date.now() < cached.expiresAt) {
    return { details: cached.details, respondedAt: cached.respondedAt, cachedAt: cached.cachedAt, cached: true };
  }
  const pending = inFlight.get(trainNumber);
  if (pending) return { ...(await pending), cached: false, requested: false };
  if (!allowRequest) return { skipped: true };

  reserveRequest();
  const request = requestTrainDetails(trainNumber);
  inFlight.set(trainNumber, request);
  try {
    return { ...(await request), cached: false, requested: true };
  } finally {
    inFlight.delete(trainNumber);
  }
}

/** Just the details (or null) — see lookupTrain. */
async function fetchTrainDetails(trainNumber) {
  return (await lookupTrain(trainNumber)).details;
}

// Overlays IRCTC's own timings and running days at the boarding/alighting
// stations onto a timetable train, plus `runsOnDate` (false when IRCTC says it
// doesn't leave the boarding station on `date`). Returns null if the train
// doesn't serve that pair in order.
function applyLiveSchedule(train, details, date) {
  const fromCode = codeFromLabel(train.fromStation);
  const toCode = codeFromLabel(train.toStation);
  const stops = details.schedule;
  const fromIdx = stops.findIndex((s) => s.stationCode === fromCode);
  const toIdx = stops.findIndex((s, i) => i > fromIdx && s.stationCode === toCode);
  if (fromIdx === -1 || toIdx === -1) return null;

  const dep = clockMinutes(stops[fromIdx].departureTime);
  const arr = clockMinutes(stops[toIdx].arrivalTime);
  if (dep == null || arr == null) return null;

  const dayDiff = (parseInt(stops[toIdx].dayCount, 10) || 1) - (parseInt(stops[fromIdx].dayCount, 10) || 1);
  const durationMinutes = dayDiff * 1440 + arr - dep;
  if (durationMinutes <= 0) return null;
  const extraDays = Math.floor((dep + durationMinutes) / 1440);
  const runs = runningDaysAt(details.runningOn, stops[fromIdx].dayCount);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

  return {
    ...train,
    trainName: details.trainName || train.trainName,
    trainType: deriveTrainType(details.trainName || train.trainName),
    departureTime: hhmm(dep),
    arrivalTime: extraDays > 0 ? `${hhmm(arr)} (+${extraDays})` : hhmm(arr),
    durationMinutes,
    duration: `${Math.floor(durationMinutes / 60)}h ${String(durationMinutes % 60).padStart(2, '0')}m`,
    days: runs ? describeDays(runs) : train.days,
    runsOnDate: runs && !Number.isNaN(weekday) ? runs[weekday] : true
  };
}

/**
 * Every stop of one train from IRCTC, in the same shape as
 * erail.service.fetchTrainSchedule (backs GET /api/trains/schedule), plus
 * `irctc: { respondedAt, cached }`. null when IRCTC has no train for that
 * number (or its empty answer is cached).
 */
async function fetchIrctcSchedule(trainNumber) {
  const { details, respondedAt, cached } = await lookupTrain(trainNumber);
  if (!details) return null;
  const stops = details.schedule.map((s) => {
    const arrival = clockMinutes(s.arrivalTime);
    const departure = clockMinutes(s.departureTime);
    const halt = /^(\d+):\d{2}$/.exec(s.haltTime || '');
    return {
      code: s.stationCode,
      name: s.stationName,
      routeNumber: parseInt(s.routeNumber, 10) || 1,
      arrival: arrival == null ? null : hhmm(arrival),
      departure: departure == null ? null : hhmm(departure),
      halt: halt && arrival != null && departure != null ? parseInt(halt[1], 10) : null,
      distance: /^\d+$/.test(s.distance) ? parseInt(s.distance, 10) : null,
      day: parseInt(s.dayCount, 10) || 1
    };
  });
  const first = details.schedule[0];
  const last = details.schedule[details.schedule.length - 1];
  return {
    train: {
      number: details.trainNumber || trainNumber,
      name: details.trainName || '',
      fromCode: details.stationFrom || first.stationCode, fromName: first.stationName,
      toCode: details.stationTo || last.stationCode, toName: last.stationName,
      days: describeDays(runningDaysAt(details.runningOn, 1))
    },
    stops,
    irctc: { respondedAt, cached }
  };
}

// Reasons that stop every further request in a search.
const STOP_REASONS = new Set(['not_configured', 'disabled', 'budget_exhausted', 'rate_limited', 'not_subscribed', 'usage_locked']);

/**
 * Trains fromCode -> toCode on `date` from the public timetable, each verified
 * against IRCTC where possible. At most `maxLookups` new requests are sent
 * (0 = cache and in-flight requests only). Every train comes back with:
 *   - source 'live-schedule' (IRCTC answered during this search),
 *     'cached-schedule' (IRCTC's answer from an earlier request) or
 *     'schedule' (timetable only); verified trains carry verifiedAt (when
 *     IRCTC answered)
 *   - classes: fare-chart prices, liveFares: false (this API has no fares)
 * stopReason is why requests stopped (rate_limited, not_subscribed,
 * budget_exhausted, disabled, not_configured); lookupFailed is set when any
 * other error left a train unverified.
 */
async function fetchTrainsBetweenStations(fromCode, toCode, date, fromLabel, toLabel, { maxLookups = 0 } = {}) {
  // Required lazily: erail.service requires this module for deriveTrainType.
  const { fetchErailTrains } = require('./erail.service');
  const { findStationByCode } = require('./stations.service');
  const stationLabel = (code) => {
    const station = findStationByCode(code);
    return station ? `${station.name} (${station.code})` : code;
  };

  const candidates = await fetchErailTrains(fromCode, toCode, date, stationLabel);

  let lookupsLeft = maxLookups;
  let stopReason = null;
  let lookupFailed = false;
  const trains = [];
  for (const train of candidates) {
    let found = null;
    try {
      found = await lookupTrain(train.trainNumber, { allowRequest: lookupsLeft > 0 && !stopReason });
      if (found.requested) lookupsLeft -= 1;
    } catch (err) {
      if (STOP_REASONS.has(err.reason)) stopReason = stopReason || err.reason;
      else {
        lookupFailed = true;
        lookupsLeft -= 1;
      }
      if (err.reason !== 'disabled' && err.reason !== 'not_configured') console.warn(`[trains] Live lookup for train ${train.trainNumber} failed:`, err.message);
    }
    const verified = found && found.details ? applyLiveSchedule(train, found.details, date) : null;
    if (verified && !verified.runsOnDate) continue;
    if (verified) delete verified.runsOnDate;
    trains.push({
      ...(verified || train),
      ...(verified ? { verifiedAt: found.respondedAt } : {}),
      classesAvailable: train.classes.map((c) => c.cls),
      liveFares: false,
      source: !verified ? 'schedule' : found.cached ? 'cached-schedule' : 'live-schedule'
    });
  }
  return { trains, stopReason, lookupFailed, rateLimited: stopReason === 'rate_limited', notSubscribed: stopReason === 'not_subscribed' };
}

/**
 * This API offers no per-class fare or seat-status endpoint, so live
 * availability can't be refreshed — callers report it as unavailable.
 */
async function fetchSeatAvailability() {
  throw new IrctcApiError(REASON_MESSAGES.not_supported, 501, null, 'not_supported');
}

/**
 * Route search for /api/trains/search: the full timetable list, with up to
 * MAX_LOOKUPS_PER_SEARCH new IRCTC requests (`verify: false` -> cache only).
 */
async function searchLiveTrains({ fromCode, toCode, date, fromLabel, toLabel, verify = true }) {
  return fetchTrainsBetweenStations(fromCode, toCode, date, fromLabel, toLabel, { maxLookups: verify ? MAX_LOOKUPS_PER_SEARCH : 0 });
}

module.exports = {
  searchLiveTrains,
  fetchTrainsBetweenStations,
  lookupTrain,
  fetchTrainDetails,
  fetchIrctcSchedule,
  fetchSeatAvailability,
  requestBudgetStatus,
  startNewBudgetPeriod,
  reserveRequest,
  configuredPeriod,
  resetStateForTests,
  IrctcApiError,
  REASON_MESSAGES,
  deriveTrainType,
  describeDays,
  runningDaysAt,
  parseMaxLookups,
  parseRequestBudget,
  MAX_LOOKUPS_PER_SEARCH
};
