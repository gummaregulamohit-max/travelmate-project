// Live Indian Railways train data via the "Indian Railway IRCTC" API on
// RapidAPI (https://rapidapi.com/rahilkhan224/api/indian-railway-irctc).
// Requires RAPIDAPI_KEY in .env — see .env.example.
//
// This API has no "trains between stations" or fare/seat-availability
// endpoint — only train-by-number (full IRCTC schedule) and live running
// status. So a route search is built in two steps:
//   1. The candidate trains for the route come from the public timetable
//      (erail.service.js), with its fare-chart prices.
//   2. Up to MAX_LOOKUPS_PER_SEARCH of them are verified against IRCTC via
//      GET /api/trains-search/v1/train/{trainNo}, replacing the timings with
//      IRCTC's own departure/arrival at the searched stations.
// The free BASIC plan allows only 50 calls a month, so each train's details
// are cached for DETAILS_TTL_MS (schedules rarely change) and a 429 stops all
// further lookups for that search.

const axios = require('axios');

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'indian-railway-irctc.p.rapidapi.com';
const BASE_URL = `https://${RAPIDAPI_HOST}`;
const REQUEST_TIMEOUT_MS = 12000;

const MAX_LOOKUPS_PER_SEARCH = Number(process.env.TRAIN_API_MAX_LOOKUPS_PER_SEARCH) || 3;
const DETAILS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const detailsCache = new Map();

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
 * of the plan's 50 monthly requests.
 */
async function fetchTrainDetails(trainNumber) {
  const cached = detailsCache.get(trainNumber);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  try {
    const response = await axios.get(`${BASE_URL}/api/trains-search/v1/train/${encodeURIComponent(trainNumber)}`, {
      params: { isH5: true, client: 'web' },
      headers: headers(),
      timeout: REQUEST_TIMEOUT_MS
    });
    const remaining = response.headers['x-ratelimit-requests-remaining'];
    if (remaining != null) console.log(`[trains] Indian Railway IRCTC API: ${remaining} requests left this period.`);

    const train = response.data?.body?.[0]?.trains?.[0];
    const value = train && Array.isArray(train.schedule) ? train : null;
    detailsCache.set(trainNumber, { value, expiresAt: Date.now() + DETAILS_TTL_MS });
    return value;
  } catch (err) {
    throw asIrctcError(err, `Failed to fetch train ${trainNumber} from the live IRCTC API.`);
  }
}

function cachedTrainDetails(trainNumber) {
  const cached = detailsCache.get(trainNumber);
  return cached && Date.now() < cached.expiresAt ? cached.value : undefined;
}

// Overlays IRCTC's own timings at the boarding/alighting stations onto a
// timetable train. Returns null if the train doesn't serve that pair in order.
function applyLiveSchedule(train, details) {
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

  return {
    ...train,
    trainName: details.trainName || train.trainName,
    trainType: deriveTrainType(details.trainName || train.trainName),
    departureTime: hhmm(dep),
    arrivalTime: extraDays > 0 ? `${hhmm(arr)} (+${extraDays})` : hhmm(arr),
    durationMinutes,
    duration: `${Math.floor(durationMinutes / 60)}h ${String(durationMinutes % 60).padStart(2, '0')}m`
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
    const verified = details ? applyLiveSchedule(train, details) : null;
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

module.exports = { searchLiveTrains, fetchTrainsBetweenStations, fetchTrainDetails, fetchSeatAvailability, IrctcApiError, deriveTrainType };
