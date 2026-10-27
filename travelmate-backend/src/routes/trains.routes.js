const express = require('express');
const router = express.Router();

const { searchStations, findStationByCode } = require('../services/stations.service');
const { hasRetiringRoom } = require('../services/retiringRoom.service');
const { searchLiveTrains, fetchTrainsBetweenStations, fetchIrctcSchedule, fetchSeatAvailability, deriveTrainType, REASON_MESSAGES } = require('../services/irctc.service');
const { estimateClassFare } = require('../utils/mockTrainGenerator');
const { findKnownTrains } = require('../data/knownTrainRoutes');
const { fetchErailTrains, fetchTrainSchedule } = require('../services/erail.service');
const { checkTravelDate, travelDateMessage, extractStationCode, queryString, parseLimit } = require('../utils/requestNormalizers');
const { getCached, setCached } = require('../services/cache.service');
const { IRCTC_SEAT_CHECK_URL, SEAT_CHECK_STATUS, REASONS, withSeatCheck, availabilityReason } = require('../utils/seatAvailability');
// /search and /schedule can send IRCTC (RapidAPI) requests and erail.in calls.
const { trainsLimiter } = require('../middleware/rateLimit');

// How erail.in data is labelled in responses: the published Indian Railways
// timetable and fare chart, fetched when the response was built (meta
// fetchedAt) — reference data, not live or IRCTC-verified.
const TIMETABLE_SOURCE = { source: 'timetable', provider: 'erail.in public timetable', live: false };
const IRCTC_PROVIDER = 'Indian Railway IRCTC (RapidAPI)';
// IRCTC reasons meaning "couldn't ask", not "no such train".
const STOPPED = new Set(['rate_limited', 'not_subscribed', 'budget_exhausted', 'usage_locked']);

// A search answer served again from the route cache: IRCTC data in it was
// live when first fetched, so it is relabelled cached (with its original
// verifiedAt), never live merely because it was served again.
function asCachedSearch(payload) {
  const results = payload.results.map((t) => (t.source === 'live-schedule' ? { ...t, source: 'cached-schedule' } : t));
  const v = payload.meta.verification;
  const verification = {
    ...v,
    status: v.status === 'verified' ? 'cached' : v.status,
    liveTrains: 0,
    cachedTrains: (v.cachedTrains || 0) + (v.liveTrains || 0)
  };
  const dataStatus = payload.meta.dataStatus === 'live_verified' ? 'cached_verified' : payload.meta.dataStatus;
  return { results, meta: { ...payload.meta, verification, dataStatus, cached: true } };
}

function stationLabel(code) {
  const station = findStationByCode(code);
  return station ? `${station.name} (${station.code})` : code;
}

// Bengaluru and Hyderabad/Secunderabad (like several other Indian metros)
// each have multiple real terminals that IRCTC schedules trains against
// independently — a search for exactly SBC->KCG misses real trains that run
// out of YPR, SMVB, SC, or HYB instead. When a search's endpoints fall in two
// different clusters below, we aggregate across every terminal combination so
// the rider sees all the real options for their city pair, not just the one
// exact station pair they happened to pick.
const CITY_CLUSTERS = [
  { city: 'Bengaluru', codes: ['SBC', 'YPR', 'SMVB'] },
  { city: 'Hyderabad/Secunderabad', codes: ['KCG', 'SC', 'HYB'] }
];

function clusterFor(code) {
  return CITY_CLUSTERS.find((c) => c.codes.includes(code)) || null;
}

// All (fromCode, toCode) pairs across the two clusters `from`/`to` belong to,
// excluding the exact pair already searched. Returns [] when either endpoint
// isn't part of a recognized metro cluster, or both are in the same one.
function clusterPairs(from, to) {
  const fromCluster = clusterFor(from);
  const toCluster = clusterFor(to);
  // Either end can be a multi-terminal city (e.g. Bengaluru -> Markapur Road
  // also covers YPR / SMVB departures), like IRCTC's own train list.
  if ((!fromCluster && !toCluster) || fromCluster === toCluster) return [];

  const pairs = [];
  for (const f of fromCluster ? fromCluster.codes : [from]) {
    for (const t of toCluster ? toCluster.codes : [to]) {
      if (f === from && t === to) continue;
      pairs.push([f, t]);
    }
  }
  return pairs;
}

function dedupeByTrainNumber(trains) {
  const seen = new Set();
  return trains.filter((t) => {
    if (seen.has(t.trainNumber)) return false;
    seen.add(t.trainNumber);
    return true;
  });
}

// Fills in a real train's classes with an estimated fare/status wherever the
// live seat-availability call didn't come back (rate-limited, timed out,
// etc.), so a partially-live result still shows all of its classes — clearly
// marked `live: false` per class rather than blended in as if it were real.
function fillMissingClasses(train) {
  const liveClasses = train.classes || [];
  const liveByCls = new Map(liveClasses.map((c) => [c.cls, c]));
  const classes = train.classesAvailable.map((cls) => {
    const live = liveByCls.get(cls);
    if (live) return { ...live, live: true };
    return { cls, fare: estimateClassFare(cls, train.durationMinutes), status: SEAT_CHECK_STATUS, tier: 'unknown', live: false };
  });
  return classes;
}

/**
 * GET /api/trains/stations?q=<query>&limit=<n>
 * Case-insensitive substring search over station name or code. Backs live
 * autocomplete on the Trains tab. An empty/missing q returns no results, like
 * /api/locations/search. `limit` defaults to 20 (1..100); meta.total is the
 * number of matches before the limit.
 */
router.get('/stations', (req, res, next) => {
  try {
    const query = queryString(req.query.q);
    const limit = parseLimit(req.query.limit);
    const matches = query ? searchStations(query) : [];
    const results = matches.slice(0, limit).map(({ name, code, city, state }) => ({ name, code, city, state }));
    res.json({ results, meta: { query, count: results.length, total: matches.length } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trains/class-availability?trainNumber=<no>&classType=<cls>&from=<code>&to=<code>&date=<date>
 *
 * On-demand live fare/seat-status lookup for one (train, class) — backs the
 * "Refresh" button on an individual class pill, since the bulk /search above
 * only enriches its first few trains with live fares up front. Always hits
 * the live API directly (no verified/estimated fallback tier here — a stale
 * estimate re-labeled as a "refresh" would defeat the point of the button).
 *
 * Without a live answer it returns 200 { live: false, cls, reason, message,
 * checkUrl }, where `reason` is one of utils/seatAvailability REASONS —
 * "not_supported" with the current train API, which has no seat-status
 * endpoint — and `checkUrl` is IRCTC's train search. It never means "no seats".
 */
router.get('/class-availability', async (req, res, next) => {
  try {
    const trainNumber = typeof req.query.trainNumber === 'string' ? req.query.trainNumber.trim() : '';
    const classType = typeof req.query.classType === 'string' ? req.query.classType.trim().toUpperCase() : '';
    const from = extractStationCode(req.query.from);
    const to = extractStationCode(req.query.to);
    const dateCheck = checkTravelDate(req.query.date);
    const date = dateCheck.date;

    if (dateCheck.error === 'past') {
      return res.status(400).json({ error: { message: travelDateMessage(dateCheck), status: 400 } });
    }
    if (!trainNumber || !classType || !from || !to || !date) {
      return res.status(400).json({ error: { message: 'trainNumber, classType, from, to, and date are all required.', status: 400 } });
    }
    const notLive = (reason, message) => res.json({ live: false, cls: classType, reason, message, checkUrl: IRCTC_SEAT_CHECK_URL });
    if (!process.env.RAPIDAPI_KEY) {
      return notLive(REASONS.NOT_CONFIGURED, 'Live refresh is not configured on this server.');
    }

    try {
      const result = await fetchSeatAvailability({ trainNumber, fromCode: from, toCode: to, classType, date });
      if (!result) {
        return notLive(REASONS.NO_DATA, 'No live update available for this class right now.');
      }
      res.json({ live: true, ...result });
    } catch (err) {
      const reason = availabilityReason(err);
      // Only fixed text reaches the browser (IrctcApiError's publicMessage),
      // never a provider's own message.
      notLive(reason, reason === REASONS.RATE_LIMITED ? 'Live lookups are rate-limited right now — try again shortly.'
        : err.publicMessage || 'No live update available for this class right now.');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trains/schedule?train=<number>
 * Every stop of one train (code, name, arrival, departure, halt, km, day),
 * for the "Train Schedule" pop-up on a train card.
 * IRCTC's own schedule (through irctc.service's cache, in-flight sharing and
 * request budget, so a train already looked up costs no quota) with the
 * erail timetable as fallback when IRCTC is off, unavailable or has no answer.
 * meta says which, and how fresh:
 *   { source: 'irctc', status: 'live' | 'cached', live, cached, respondedAt }
 *   { source: 'timetable', status: 'timetable', live: false, cached, fetchedAt }
 * plus meta.verification { provider, status, message } when IRCTC gave no
 * schedule (status is a reason such as rate_limited / not_subscribed / disabled).
 * 404 only when every source answered and none knows the train; 503 when a
 * source failed — that never means the train doesn't exist.
 */
router.get('/schedule', trainsLimiter, async (req, res, next) => {
  try {
    const train = typeof req.query.train === 'string' ? req.query.train.trim() : '';
    if (!/^\d{4,5}$/.test(train)) {
      return res.status(400).json({ error: { message: 'A valid train number is required (e.g. "12295").', status: 400 } });
    }
    const cacheKey = `schedule:${train}`;
    const cached = getCached(cacheKey);
    if (cached) {
      const meta = { ...cached.meta, cached: true };
      if (meta.source === 'irctc') Object.assign(meta, { status: 'cached', live: false });
      return res.json({ ...cached, meta });
    }

    let schedule = null;
    let meta = null;
    // Why IRCTC gave no schedule: 'none' (it has no such train), or a reason
    // from irctc.service REASON_MESSAGES.
    let irctcStatus = 'none';
    let failed = false;
    try {
      const irctc = await fetchIrctcSchedule(train);
      if (irctc) {
        const { irctc: answered, ...rest } = irctc;
        schedule = rest;
        meta = { source: 'irctc', provider: IRCTC_PROVIDER, status: answered.cached ? 'cached' : 'live', live: !answered.cached, cached: answered.cached, respondedAt: answered.respondedAt };
      }
    } catch (err) {
      irctcStatus = err.reason || 'failed';
      if (err.reason === 'failed' || !err.reason) failed = true;
      if (err.reason !== 'disabled' && err.reason !== 'not_configured') console.warn(`[trains] IRCTC schedule for ${train} unavailable, falling back to erail:`, err.message);
    }
    if (!schedule) {
      try {
        schedule = await fetchTrainSchedule(train);
      } catch (err) {
        failed = true;
        console.warn(`[trains] erail schedule for ${train} failed:`, err.message);
      }
      if (schedule) meta = { ...TIMETABLE_SOURCE, status: 'timetable', cached: false, fetchedAt: new Date().toISOString() };
    }
    const verification = irctcStatus === 'none' && meta && meta.source === 'irctc'
      ? null
      : { provider: IRCTC_PROVIDER, status: irctcStatus, message: REASON_MESSAGES[irctcStatus] || null };
    if (!schedule) {
      if (failed || STOPPED.has(irctcStatus)) {
        return res.status(503).json({ error: {
          message: `The schedule for train ${train} is unavailable right now. This does not mean the train doesn't exist — please check NTES or IRCTC.`,
          status: 503, reason: failed ? 'provider_unavailable' : irctcStatus
        } });
      }
      return res.status(404).json({ error: { message: `No schedule found for train ${train}.`, status: 404 } });
    }
    schedule = { ...schedule, meta: verification ? { ...meta, verification } : meta };
    setCached(cacheKey, schedule);
    res.json(schedule);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trains/search?from=<code>&to=<code>&date=<date>
 *
 * Tried in order:
 *   1. Default: the "Indian Railway IRCTC" RapidAPI (irctc.service.js) —
 *      the route's timetable trains, with up to 3 per search (more from
 *      cache) verified live: IRCTC's timings and running days replace the
 *      timetable's; fares are fare-chart prices. Requires RAPIDAPI_KEY in .env.
 *   2. The public Indian Railways timetable via erail.in (erail.service.js)
 *      — every real train on the route with fare-chart prices, used when the
 *      live API has no key configured, errors, or is out of quota.
 *   3. A static reference timetable (knownTrainRoutes.js) for the handful of
 *      routes we've checked by hand — used if erail is unreachable too.
 *      Labelled source 'reference': it is never live or IRCTC-verified.
 *   4. Otherwise no trains — invented schedules would not match IRCTC.
 * Every tier flags retiring room availability from IRCTC Retiring Room.pdf.
 *
 * `verify=0` sends no new IRCTC request (cached IRCTC answers still apply) —
 * for the extra station pairs of a city search and the Compare page.
 * meta.dataStatus: 'live_verified' (IRCTC answered during this request) |
 * 'cached_verified' (IRCTC data from earlier, incl. a cached search) |
 * 'timetable' (timetable / reference data only) | 'no_results' |
 * 'provider_unavailable' (no trains because a source failed — not "no trains").
 */
router.get('/search', trainsLimiter, async (req, res, next) => {
  try {
    const from = extractStationCode(req.query.from);
    const to = extractStationCode(req.query.to);
    const dateCheck = checkTravelDate(req.query.date);
    const date = dateCheck.date;

    if (!from) {
      return res.status(400).json({ error: { message: 'A valid "from" station code is required (e.g. "NDLS").', status: 400 } });
    }
    if (!to) {
      return res.status(400).json({ error: { message: 'A valid "to" station code is required (e.g. "MMCT").', status: 400 } });
    }
    if (from === to) {
      return res.status(400).json({ error: { message: 'Origin and destination cannot be the same station.', status: 400 } });
    }
    if (!date) {
      return res.status(400).json({ error: { message: travelDateMessage(dateCheck), status: 400 } });
    }

    // The live tier below can fire off a dozen-plus RapidAPI calls for a single
    // search (schedule + per-class fares, doubled again for metro-cluster
    // routes), and that API's free plan has a hard monthly cap — so identical
    // repeat searches within the TTL are served from cache instead of re-hitting it.
    const verify = req.query.verify !== '0' && req.query.verify !== 'false';
    const cacheKey = JSON.stringify({ from, to, date, verify });
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(asCachedSearch(cached));
    }

    const [fromHasRetiringRoom, toHasRetiringRoom] = await Promise.all([hasRetiringRoom(from), hasRetiringRoom(to)]);
    const hasRetiringRoomFlag = fromHasRetiringRoom || toHasRetiringRoom;

    const fromLabel = stationLabel(from);
    const toLabel = stationLabel(to);

    let results = null;
    let source = null;
    // Set when a data source errored, so an empty answer isn't cached as if
    // the route genuinely had no trains.
    let sourceFailed = false;
    // Whether IRCTC (RapidAPI) confirmed any train's timings, and if not why:
    // "verified" (IRCTC answered during this search) | "cached" (only earlier
    // IRCTC answers) | "rate_limited" (plan quota used up) | "not_subscribed"
    // (key has no subscription to the API) | "budget_exhausted" (this
    // server's TRAIN_API_REQUEST_BUDGET is used up) | "disabled" (live
    // requests off) | "failed" | "none" (nothing confirmed) |
    // "not_configured" (no RAPIDAPI_KEY).
    let verificationStatus = process.env.RAPIDAPI_KEY ? 'none' : 'not_configured';
    let liveTrains = 0;
    let cachedTrains = 0;

    const extraPairs = clusterPairs(from, to);

    // Tier 1: live IRCTC API.
    if (process.env.RAPIDAPI_KEY) {
      try {
        const { trains, stopReason, lookupFailed } = await searchLiveTrains({ fromCode: from, toCode: to, date, fromLabel, toLabel, verify });
        let allTrains = trains;

        // Metro routes: also pull the listing for every other real terminal
        // combination (cache-only live lookups, so no extra API quota), so trains
        // that only run out of YPR/SMVB/SC/HYB aren't missed.
        if (extraPairs.length) {
          for (const [f, t] of extraPairs) {
            try {
              const extra = await fetchTrainsBetweenStations(f, t, date, stationLabel(f), stationLabel(t));
              allTrains = allTrains.concat(extra.trains);
            } catch (err) {
              console.warn(`[trains] Cluster timetable lookup ${f}->${t} failed:`, err.message);
            }
          }
        }

        allTrains = dedupeByTrainNumber(allTrains);
        liveTrains = allTrains.filter((t) => t.source === 'live-schedule').length;
        cachedTrains = allTrains.filter((t) => t.source === 'cached-schedule').length;
        verificationStatus = stopReason || (liveTrains ? 'verified' : cachedTrains ? 'cached' : lookupFailed ? 'failed' : 'none');

        if (allTrains.length) {
          results = allTrains.map((t) => ({
            trainNumber: t.trainNumber,
            trainName: t.trainName,
            trainType: t.trainType,
            fromStation: t.fromStation,
            toStation: t.toStation,
            departureTime: t.departureTime,
            arrivalTime: t.arrivalTime,
            duration: t.duration,
            days: t.days,
            // Timetable trains already carry fare-chart prices; only live-fare
            // trains need estimates filled in for missing classes.
            classes: t.liveFares || !t.classes ? fillMissingClasses(t) : t.classes,
            hasRetiringRoom: hasRetiringRoomFlag,
            source: t.source || (t.liveFares ? 'live' : 'live-schedule'),
            ...(t.verifiedAt ? { verifiedAt: t.verifiedAt } : {})
          }));
          // Without live fares the prices are fare-chart ones, so report
          // 'schedule' (the frontend labels it "listed fare", not "live").
          const anyLiveFares = allTrains.some((t) => t.liveFares);
          source = !anyLiveFares ? 'schedule' : stopReason ? 'live-partial' : 'live';
        }
        // An empty live response is left as `results === null` (rather than an
        // authoritative "no trains") so tiers 2/3 below still get a chance —
        // a genuinely-empty live payload is indistinguishable here from one
        // caused by rate limiting, a transient IRCTC outage, or a response
        // shape this integration doesn't yet parse, so the UI should never
        // go blank on that alone when a verified/estimated schedule exists.
      } catch (err) {
        sourceFailed = true;
        // IRCTC lookups report their own errors; anything thrown here is the
        // timetable listing failing before IRCTC was asked.
        if (err.reason && err.reason !== 'not_supported') verificationStatus = err.reason;
        console.warn('[trains] Live IRCTC API call failed, falling back:', err.message);
      }
    }

    // Tier 2: public timetable (erail.in).
    if (results === null) {
      try {
        const scheduled = await fetchErailTrains(from, to, date, stationLabel);
        if (scheduled.length) {
          results = scheduled.map((t) => ({ ...t, hasRetiringRoom: hasRetiringRoomFlag, source: 'schedule' }));
          source = 'schedule';
        }
      } catch (err) {
        sourceFailed = true;
        console.warn('[trains] erail timetable lookup failed, falling back:', err.message);
      }
    }

    // Tier 3: known routes (knownTrainRoutes.js, a static hand-checked
    // timetable) — also aggregated across metro clusters. Reference data,
    // never IRCTC-verified: source 'reference'.
    if (results === null) {
      const merged = [];
      const seen = new Set();
      for (const [f, t] of [[from, to], ...extraPairs]) {
        const knownTrains = findKnownTrains(f, t);
        if (!knownTrains) continue;
        for (const train of knownTrains) {
          if (seen.has(train.trainNumber)) continue;
          seen.add(train.trainNumber);
          merged.push({
            ...train,
            trainType: deriveTrainType(train.trainName),
            fromStation: stationLabel(f),
            toStation: stationLabel(t),
            hasRetiringRoom: hasRetiringRoomFlag,
            source: 'reference'
          });
        }
      }
      if (merged.length) {
        results = merged;
        source = 'reference';
      }
    }

    // No live or verified data: report no trains rather than inventing train
    // names and numbers that don't exist on IRCTC. (Live data for every
    // station pair needs RAPIDAPI_KEY — see .env.example.)
    if (results === null) {
      results = [];
      source = sourceFailed ? 'unavailable' : 'none';
    }

    // Fares here are fare-chart or estimated prices, never live seat status:
    // only a class a real source marked live keeps one (see withSeatCheck).
    results = results.map((t) => ({ ...t, classes: withSeatCheck(t.classes) }));
    const seatAvailability = { live: false, reason: REASONS.NOT_SUPPORTED, checkUrl: IRCTC_SEAT_CHECK_URL };
    const verification = {
      provider: IRCTC_PROVIDER, status: verificationStatus,
      verifiedTrains: liveTrains + cachedTrains, liveTrains, cachedTrains,
      message: REASON_MESSAGES[verificationStatus] || null
    };
    const dataStatus = !results.length ? (sourceFailed ? 'provider_unavailable' : 'no_results')
      : liveTrains ? 'live_verified' : cachedTrains ? 'cached_verified' : 'timetable';
    // Every 'schedule' / '*-schedule' train is listed from the erail.in
    // timetable (IRCTC only re-times the verified ones), and its fares are
    // that timetable's fare chart.
    const timetable = results.some((t) => /^(schedule|live-schedule|cached-schedule)$/.test(t.source))
      ? { ...TIMETABLE_SOURCE, fetchedAt: new Date().toISOString() }
      : null;
    const payload = { results, meta: { from, to, date, count: results.length, source, dataStatus, seatAvailability, verification, timetable, cached: false } };
    if (results.length || !sourceFailed) setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
