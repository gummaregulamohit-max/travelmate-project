const express = require('express');
const router = express.Router();

const { searchStations, findStationByCode } = require('../services/stations.service');
const { hasRetiringRoom } = require('../services/retiringRoom.service');
const { searchLiveTrains, fetchTrainsBetweenStations, fetchSeatAvailability, deriveTrainType } = require('../services/irctc.service');
const { estimateClassFare } = require('../utils/mockTrainGenerator');
const { findKnownTrains } = require('../data/knownTrainRoutes');
const { fetchErailTrains, fetchTrainSchedule } = require('../services/erail.service');
const { normalizeDateToISO, extractStationCode, queryString, parseLimit } = require('../utils/requestNormalizers');
const { getCached, setCached } = require('../services/cache.service');

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
    return { cls, fare: estimateClassFare(cls, train.durationMinutes), status: 'Check availability', tier: 'available', live: false };
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
 * estimate re-labeled as a "refresh" would defeat the point of the button),
 * so this cleanly reports "unavailable" rather than lying about freshness.
 */
router.get('/class-availability', async (req, res, next) => {
  try {
    const trainNumber = typeof req.query.trainNumber === 'string' ? req.query.trainNumber.trim() : '';
    const classType = typeof req.query.classType === 'string' ? req.query.classType.trim().toUpperCase() : '';
    const from = extractStationCode(req.query.from);
    const to = extractStationCode(req.query.to);
    const date = normalizeDateToISO(req.query.date);

    if (!trainNumber || !classType || !from || !to || !date) {
      return res.status(400).json({ error: { message: 'trainNumber, classType, from, to, and date are all required.', status: 400 } });
    }
    if (!process.env.RAPIDAPI_KEY) {
      return res.json({ live: false, cls: classType, message: 'Live refresh is not configured on this server.' });
    }

    try {
      const result = await fetchSeatAvailability({ trainNumber, fromCode: from, toCode: to, classType, date });
      if (!result) {
        return res.json({ live: false, cls: classType, message: 'No live update available for this class right now.' });
      }
      res.json({ live: true, ...result });
    } catch (err) {
      res.json({ live: false, cls: classType, message: err.rateLimited ? 'Live lookups are rate-limited right now — try again shortly.' : err.message });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trains/schedule?train=<number>
 * Every stop of one train (code, name, arrival, departure, halt, km, day),
 * for the "Train Schedule" pop-up on a train card. 404 when unknown.
 */
router.get('/schedule', async (req, res, next) => {
  try {
    const train = typeof req.query.train === 'string' ? req.query.train.trim() : '';
    if (!/^\d{4,5}$/.test(train)) {
      return res.status(400).json({ error: { message: 'A valid train number is required (e.g. "12295").', status: 400 } });
    }
    const cacheKey = `schedule:${train}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const schedule = await fetchTrainSchedule(train);
    if (!schedule) {
      return res.status(404).json({ error: { message: `No schedule found for train ${train}.`, status: 404 } });
    }
    setCached(cacheKey, schedule);
    res.json(schedule);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/trains/search?from=<code>&to=<code>&date=<date>
 *
 * Three-tier fallback, tried in order:
 *   1. Timetable trains with IRCTC-verified timings via the "Indian Railway
 *      IRCTC" RapidAPI (irctc.service.js) — up to 3 trains per search are
 *      checked live; fares are fare-chart prices. Requires RAPIDAPI_KEY in .env.
 *   2. The public Indian Railways timetable via erail.in (erail.service.js)
 *      — every real train on the route with fare-chart prices, used when the
 *      live API has no key configured, errors, or is out of quota.
 *   3. Real, verified train data (knownTrainRoutes.js) for the handful of
 *      routes we've confirmed by hand — used if erail is unreachable too.
 *   4. Otherwise no trains — invented schedules would not match IRCTC.
 * All three flag retiring room availability from IRCTC Retiring Room.pdf.
 */
router.get('/search', async (req, res, next) => {
  try {
    const from = extractStationCode(req.query.from);
    const to = extractStationCode(req.query.to);
    const date = normalizeDateToISO(req.query.date);

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
      return res.status(400).json({ error: { message: 'A valid "date" is required, as YYYY-MM-DD or DD-MM-YYYY.', status: 400 } });
    }

    // The live tier below can fire off a dozen-plus RapidAPI calls for a single
    // search (schedule + per-class fares, doubled again for metro-cluster
    // routes), and that API's free plan has a hard monthly cap — so identical
    // repeat searches within the TTL are served from cache instead of re-hitting it.
    const cacheKey = JSON.stringify({ from, to, date });
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
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

    const extraPairs = clusterPairs(from, to);

    // Tier 1: live IRCTC API.
    if (process.env.RAPIDAPI_KEY) {
      try {
        const { trains, rateLimited } = await searchLiveTrains({ fromCode: from, toCode: to, date, fromLabel, toLabel });
        let allTrains = trains;
        let anyRateLimited = rateLimited;

        // Metro routes: also pull the listing for every other real terminal
        // combination (cache-only live lookups, so no extra API quota), so trains
        // that only run out of YPR/SMVB/SC/HYB aren't missed.
        if (extraPairs.length && !rateLimited) {
          for (const [f, t] of extraPairs) {
            try {
              const extra = await fetchTrainsBetweenStations(f, t, date, stationLabel(f), stationLabel(t));
              allTrains = allTrains.concat(extra.trains);
            } catch (err) {
              if (err.rateLimited) {
                anyRateLimited = true;
                break;
              }
              console.warn(`[trains] Cluster live lookup ${f}->${t} failed:`, err.message);
            }
          }
        }

        allTrains = dedupeByTrainNumber(allTrains);

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
            source: t.source || (t.liveFares ? 'live' : 'live-schedule')
          }));
          // Without live fares the prices are fare-chart ones, so report
          // 'schedule' (the frontend labels it "listed fare", not "live").
          const anyLiveFares = allTrains.some((t) => t.liveFares);
          source = !anyLiveFares ? 'schedule' : anyRateLimited ? 'live-partial' : 'live';
        }
        // An empty live response is left as `results === null` (rather than an
        // authoritative "no trains") so tiers 2/3 below still get a chance —
        // a genuinely-empty live payload is indistinguishable here from one
        // caused by rate limiting, a transient IRCTC outage, or a response
        // shape this integration doesn't yet parse, so the UI should never
        // go blank on that alone when a verified/estimated schedule exists.
      } catch (err) {
        sourceFailed = true;
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

    // Tier 3: verified known routes — also aggregated across metro clusters.
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
            source: 'verified'
          });
        }
      }
      if (merged.length) {
        results = merged;
        source = 'verified';
      }
    }

    // No live or verified data: report no trains rather than inventing train
    // names and numbers that don't exist on IRCTC. (Live data for every
    // station pair needs RAPIDAPI_KEY — see .env.example.)
    if (results === null) {
      results = [];
      source = sourceFailed ? 'unavailable' : 'live';
    }

    const payload = { results, meta: { from, to, date, count: results.length, source } };
    if (results.length || !sourceFailed) setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
