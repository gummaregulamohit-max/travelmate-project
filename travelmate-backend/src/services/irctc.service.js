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
// The free BASIC plan allows only 50 calls a month, so each train's details
// are cached for DETAILS_TTL_MS (schedules rarely change) and a 429 stops all
// further lookups for that search. The API occasionally answers 200 with no
// train in the body, so an empty answer is only cached for EMPTY_TTL_MS.

const axios = require('axios');

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'indian-railway-irctc.p.rapidapi.com';
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const REQUEST_TIMEOUT_MS = 12000;

// How many uncached IRCTC lookups one route search may spend, from
// TRAIN_API_MAX_LOOKUPS_PER_SEARCH:
//   unset / blank        -> DEFAULT_LOOKUPS_PER_SEARCH
//   0                    -> none: searches use the timetable plus any IRCTC
//                           details already cached (schedule pop-ups still
//                           call IRCTC — they are one request each)
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

const MAX_LOOKUPS_PER_SEARCH = parseMaxLookups(process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH);
const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 60 * 60 * 1000;
const detailsCache = new Map();

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class IrctcApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'IrctcApiError';
    this.status = status || 502;
    this.rateLimited = status === 429;
    this.details = details;
  }
}

function headers() {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    throw new IrctcApiError('RAPIDAPI_KEY is not configured on the server. Set it in .env.', 500);
  }
  return { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapid-api': 'rapid-api-database' };
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

/**
 * IRCTC details for one train: { trainNumber, trainName, journeyClasses, schedule[] }.
 * Served from a week-long cache when possible — each uncached call spends one
 * of the plan's 50 monthly requests. The API intermittently answers a valid
 * train number with a successful but empty `trains: []` that an immediate
 * retry fills in, so an empty answer is retried once (a second request).
 */
async function fetchTrainDetails(trainNumber) {
  const cached = detailsCache.get(trainNumber);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  try {
    let value = null;
    for (let attempt = 1; attempt <= 2 && !value; attempt++) {
      const response = await axios.get(`${BASE_URL}/api/trains-search/v1/train/${encodeURIComponent(trainNumber)}`, {
        params: { isH5: true, client: 'web' },
        headers: headers(),
        timeout: REQUEST_TIMEOUT_MS
      });
      const remaining = response.headers['x-ratelimit-requests-remaining'];
      if (remaining != null) console.log(`[trains] Indian Railway IRCTC API: ${remaining} requests left this period.`);

      const train = response.data?.body?.[0]?.trains?.[0];
      value = train && Array.isArray(train.schedule) && train.schedule.length ? train : null;
      if (!value) console.warn(`[trains] Indian Railway IRCTC API returned no train for ${trainNumber} (attempt ${attempt} of 2).`);
    }
    detailsCache.set(trainNumber, { value, expiresAt: Date.now() + (value ? DETAILS_TTL_MS : EMPTY_TTL_MS) });
    return value;
  } catch (err) {
    throw asIrctcError(err, `Failed to fetch train ${trainNumber} from the live IRCTC API.`);
  }
}

function cachedTrainDetails(trainNumber) {
  const cached = detailsCache.get(trainNumber);
  return cached && Date.now() < cached.expiresAt ? cached.value : undefined;
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
 * erail.service.fetchTrainSchedule (backs GET /api/trains/schedule).
 * null when IRCTC returns no train for that number.
 */
async function fetchIrctcSchedule(trainNumber) {
  const details = await fetchTrainDetails(trainNumber);
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
    stops
  };
}

/**
 * Trains fromCode -> toCode on `date` from the public timetable, each verified
 * against the live IRCTC schedule where possible. At most `maxLookups`
 * uncached API calls are made (0 = cache only). Every train comes back with:
 *   - source 'live-schedule' (IRCTC-verified timings) or 'schedule' (timetable only)
 *   - classes: fare-chart prices, liveFares: false (this API has no fares)
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
  let rateLimited = false;
  const trains = [];
  for (const train of candidates) {
    let details = cachedTrainDetails(train.trainNumber);
    if (details === undefined && lookupsLeft > 0 && !rateLimited) {
      lookupsLeft -= 1;
      try {
        details = await fetchTrainDetails(train.trainNumber);
      } catch (err) {
        if (err.rateLimited) rateLimited = true;
        console.warn(`[trains] Live lookup for train ${train.trainNumber} failed:`, err.message);
      }
    }
    const verified = details ? applyLiveSchedule(train, details, date) : null;
    if (verified && !verified.runsOnDate) continue;
    if (verified) delete verified.runsOnDate;
    trains.push({
      ...(verified || train),
      classesAvailable: train.classes.map((c) => c.cls),
      liveFares: false,
      source: verified ? 'live-schedule' : 'schedule'
    });
  }
  return { trains, rateLimited };
}

/**
 * This API offers no per-class fare or seat-status endpoint, so live
 * availability can't be refreshed — callers report it as unavailable.
 */
async function fetchSeatAvailability() {
  throw new IrctcApiError('Live seat availability is not offered by the current train API — check IRCTC for the latest status.', 501);
}

/**
 * Route search for /api/trains/search: the full timetable list, with up to
 * MAX_LOOKUPS_PER_SEARCH trains verified against live IRCTC schedules.
 */
async function searchLiveTrains({ fromCode, toCode, date, fromLabel, toLabel }) {
  return fetchTrainsBetweenStations(fromCode, toCode, date, fromLabel, toLabel, { maxLookups: MAX_LOOKUPS_PER_SEARCH });
}

module.exports = {
  searchLiveTrains,
  fetchTrainsBetweenStations,
  fetchTrainDetails,
  fetchIrctcSchedule,
  fetchSeatAvailability,
  IrctcApiError,
  deriveTrainType,
  describeDays,
  runningDaysAt,
  parseMaxLookups,
  MAX_LOOKUPS_PER_SEARCH
};
