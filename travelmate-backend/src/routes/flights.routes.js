const express = require('express');
const router = express.Router();

const { searchGoogleFlights, SerpApiError } = require('../services/serpapi.service');
const { transformGoogleFlightsResponse } = require('../utils/transformSerpApiFlights');
const { generateMockFlights } = require('../utils/mockFlightGenerator');
const { getCached, setCached } = require('../services/cache.service');
const { normalizeDateToISO, extractIataCode } = require('../utils/requestNormalizers');

/**
 * GET /api/flights/search
 * Query params: origin, destination, departureDate, returnDate?, cabinClass?
 *
 * Input is normalized rather than strictly rejected where reasonably possible:
 * - origin/destination: accepts a bare IATA code ("BLR") or a combobox-style
 *   label with the code in trailing parens ("Bangalore, Kempegowda... (BLR)").
 * - departureDate/returnDate: accepts "YYYY-MM-DD" or "DD-MM-YYYY".
 * - "date" is accepted as an alias for departureDate (older frontend builds).
 */
router.get('/search', async (req, res, next) => {
  try {
    const { cabinClass } = req.query;

    const origin = extractIataCode(req.query.origin);
    const destination = extractIataCode(req.query.destination);
    const departureDate = normalizeDateToISO(req.query.departureDate || req.query.date);
    const returnDate = req.query.returnDate ? normalizeDateToISO(req.query.returnDate) : null;

    if (!origin) {
      return res.status(400).json({ error: { message: 'A valid 3-letter "origin" airport code is required (e.g. "BLR").', status: 400 } });
    }
    if (!destination) {
      return res.status(400).json({ error: { message: 'A valid 3-letter "destination" airport code is required (e.g. "DFW").', status: 400 } });
    }
    if (origin === destination) {
      return res.status(400).json({ error: { message: 'Origin and destination cannot be the same airport.', status: 400 } });
    }
    if (!departureDate) {
      return res.status(400).json({ error: { message: 'A valid "departureDate" is required, as YYYY-MM-DD or DD-MM-YYYY.', status: 400 } });
    }
    if (req.query.returnDate && !returnDate) {
      return res.status(400).json({ error: { message: 'A valid "returnDate" is required, as YYYY-MM-DD or DD-MM-YYYY.', status: 400 } });
    }

    const cacheKey = JSON.stringify({ origin, destination, departureDate, returnDate, cabinClass });
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const normalizedCabinClass = cabinClass ? cabinClass.toUpperCase() : undefined;
    let results;
    let source;

    const serpApiConfigured = !!process.env.SERPAPI_KEY;

    if (!serpApiConfigured) {
      // No API key set up yet — go straight to the mock generator so the
      // endpoint is usable out of the box during development.
      results = generateMockFlights({ origin, destination, date: departureDate, cabinClass: normalizedCabinClass });
      source = 'mock';
    } else {
      try {
        const serpApiResponse = await searchGoogleFlights({
          origin,
          destination,
          departureDate,
          returnDate,
          currency: 'INR'
        });
        results = transformGoogleFlightsResponse(serpApiResponse);
        source = 'live';

        // SerpApi responded but gave us nothing usable (no best_flights/other_flights,
        // or all entries were missing a price) — that's a genuine "no flights" result,
        // not a failure, so it's NOT routed through the mock fallback below.
      } catch (err) {
        // SerpApi errored (bad key, rate limit, outage, unsupported airport code,
        // malformed response, etc.) — degrade to the mock generator rather than
        // failing the whole search. err.details (set in serpapi.service.js) has
        // whatever SerpApi actually sent back, for server-side debugging.
        console.warn('[flights] SerpApi call failed, falling back to mock data:', err.message);
        if (err.details) console.warn('[flights] SerpApi error details:', err.details);
        results = generateMockFlights({ origin, destination, date: departureDate, cabinClass: normalizedCabinClass });
        source = 'mock';
      }
    }

    const payload = {
      results,
      meta: { origin, destination, departureDate, returnDate: returnDate || null, count: results.length, source }
    };

    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err instanceof SerpApiError ? err : err);
  }
});

module.exports = router;
