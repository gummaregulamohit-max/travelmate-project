const express = require('express');
const router = express.Router();

const { searchLocations, determineTripType, directoryStats } = require('../services/locations.service');

/**
 * GET /api/locations/search?q=<text>&limit=<n>&country=<name>&trip=<type>
 *
 * Backs the From / To autocomplete. Returns one ranked list of cities, towns
 * and villages matching `q` — by place name, by a station / airport code, or
 * by the name of one of its points ("Silk Board", "Kacheguda"). Each place
 * groups the infrastructure points that serve it:
 *
 *   { name, title, subtitle, type: "City" | "Town" | "Village", district, state,
 *     country, domestic,
 *     modes: ["flights", "trains", "buses"],
 *     points: {
 *       airports:  [{ code, name }],
 *       stations:  [{ code, name }],
 *       busPoints: [{ name }]
 *     },
 *     busPointsListed,   // false when the bus points are just named after the place
 *     links: [{ mode, label, available, codes, more }, ...],  // always flights, trains, buses
 *     match }            // present when `q` matched a point: { kind, code?, name }
 *
 * `title` / `subtitle` are what a suggestion displays; `name` is the unique
 * place name a search uses.
 *
 * `limit` defaults to 20 (max 100). `country` (optional) keeps results to one
 * country. `trip=international` keeps only places with an airport and returns
 * only their airports — trains and buses don't apply to an international trip.
 */
router.get('/search', (req, res, next) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const country = typeof req.query.country === 'string' && req.query.country.trim() ? req.query.country.trim() : undefined;
    const trip = req.query.trip === 'international' ? 'international' : undefined;
    const results = searchLocations(query, { limit, country, trip });
    res.json({ results, meta: { query, count: results.length } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/locations/trip-type?from=<text>&to=<text>
 *
 * Works out the trip type from the two places:
 *   - both in India        -> "domestic"      (flights, trains, buses)
 *   - either outside India -> "international" (flights only)
 *
 *   { tripType: "domestic" | "international" | null, modes: [...],
 *     from: <location> | null, to: <location> | null }
 *
 * `from` / `to` are the matched places in the /search result shape, plus
 * `exact` (false when the text was only a partial match). On an
 * international trip their `points` hold airports only. `tripType` is null
 * when a side matches nothing.
 */
router.get('/trip-type', (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    if (!from || !to) {
      return res.status(400).json({ error: { message: 'Both "from" and "to" are required.', status: 400 } });
    }
    res.json(determineTripType(from, to));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/locations/stats
 * Size of the directory: places by type, and how many have stations / airports.
 */
router.get('/stats', (req, res, next) => {
  try {
    res.json(directoryStats());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
