const express = require('express');
const router = express.Router();

const { searchGoogleFlights, getGoogleFlightsBookingOptions } = require('../services/serpapi.service');
const { mapGoogleFlightsResponse, mapBookingOptions } = require('../utils/transformSerpApiFlights');
const { getCached, setCached } = require('../services/cache.service');
const { checkTravelDate, travelDateMessage, travelClockMs, extractIataCode } = require('../utils/requestNormalizers');
const { flightsLimiter } = require('../middleware/rateLimit');

const CABIN_CLASSES = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];
// Google Flights sells about a year ahead; a later date can only fail, and
// every SerpApi request costs a credit, so it is refused before one is sent.
const MAX_DAYS_AHEAD = 366;
// SerpApi booking tokens are base64-style text.
const BOOKING_TOKEN_PATTERN = /^[A-Za-z0-9+/=_.-]+$/;
const MAX_AIRLINE_NAME_LENGTH = 80;

// The last date a search may ask about, as YYYY-MM-DD (UTC).
function latestSearchDate(nowMs = travelClockMs()) {
  return new Date(nowMs + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// A passenger count from the query string, clamped to Google Flights' limits.
function passengerCount(raw, fallback, max) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

function unavailable(res, status, reason, message, meta) {
  return res.status(status).json({ error: { message, status, reason }, results: [], meta: { ...meta, source: 'unavailable', count: 0 } });
}

/**
 * GET /api/flights/search
 * Query params: origin, destination, departureDate, returnDate?, cabinClass?,
 *               adults?, children?, infants?
 *
 * Input is normalized rather than strictly rejected where reasonably possible:
 * - origin/destination: accepts a bare IATA code ("BLR") or a combobox-style
 *   label with the code in trailing parens ("Bangalore, Kempegowda... (BLR)").
 * - departureDate/returnDate: accepts "YYYY-MM-DD" or "DD-MM-YYYY"; a date
 *   that isn't on the calendar, or is in the past, is a 400 (no SerpApi request).
 * - "date" is accepted as an alias for departureDate (older frontend builds).
 *
 * Every flight returned comes from SerpApi (Google Flights). When SerpApi
 * isn't configured or the request fails, the answer is an error with no
 * flights — never generated stand-in flights.
 */
// The search a request describes, or `{ error }` (a 400 message) when a
// required parameter is missing or invalid. Shared by /search and
// /booking-options, which must ask SerpApi about the very same search.
function parseFlightSearch(query) {
  const origin = extractIataCode(query.origin);
  const destination = extractIataCode(query.destination);
  const departure = checkTravelDate(query.departureDate || query.date);
  const ret = query.returnDate ? checkTravelDate(query.returnDate) : null;
  const departureDate = departure.date;
  const returnDate = ret ? ret.date : null;

  if (!origin) return { error: 'A valid 3-letter "origin" airport code is required (e.g. "BLR").' };
  if (!destination) return { error: 'A valid 3-letter "destination" airport code is required (e.g. "DFW").' };
  if (origin === destination) return { error: 'Origin and destination cannot be the same airport.' };
  if (!departureDate) return { error: travelDateMessage(departure, 'departureDate') };
  if (ret && !returnDate) return { error: travelDateMessage(ret, 'returnDate') };
  const latest = latestSearchDate();
  if (departureDate > latest) return { error: `"departureDate" can be at most ${MAX_DAYS_AHEAD} days ahead (${latest}).` };
  if (returnDate && returnDate < departureDate) return { error: '"returnDate" cannot be before "departureDate".' };
  if (returnDate && returnDate > latest) return { error: `"returnDate" can be at most ${MAX_DAYS_AHEAD} days ahead (${latest}).` };

  const cabinKey = String(query.cabinClass || 'ECONOMY').toUpperCase().replace(/[\s-]+/g, '_');
  const cabinClass = CABIN_CLASSES.includes(cabinKey) ? cabinKey : 'ECONOMY';
  const adults = Math.max(1, passengerCount(query.adults, 1, 9));
  const children = passengerCount(query.children, 0, 8);
  const infants = Math.min(passengerCount(query.infants, 0, 8), adults); // one lap infant per adult

  return {
    search: {
      origin, destination, departureDate, returnDate: returnDate || null,
      tripType: returnDate ? 'round_trip' : 'one_way', cabinClass, adults, children, infants
    }
  };
}

// A live search for `search`: the 5-minute cached answer when there is one,
// otherwise one SerpApi request. Throws when SerpApi fails (nothing cached).
async function liveSearch(search) {
  const cacheKey = JSON.stringify(search);
  const cached = getCached(cacheKey);
  // retrievedAt still says when a cached answer was fetched.
  if (cached) return { ...cached, meta: { ...cached.meta, cached: true } };

  const mapped = mapGoogleFlightsResponse(await searchGoogleFlights({ ...search, currency: 'INR' }));
  // An empty list here is a genuine live "no flights" answer.
  const payload = {
    results: mapped.results,
    meta: {
      ...search,
      count: mapped.results.length,
      unpricedCount: mapped.unpricedCount,
      currency: mapped.currency,
      // Prices are the total for every passenger searched (Google Flights' convention).
      priceBasis: 'total_for_all_passengers',
      priceInsights: mapped.priceInsights,
      googleFlightsUrl: mapped.googleFlightsUrl,
      source: 'live',
      retrievedAt: new Date().toISOString(),
      cached: false
    }
  };
  setCached(cacheKey, payload);
  return payload;
}

router.get('/search', flightsLimiter, async (req, res, next) => {
  try {
    const { search, error } = parseFlightSearch(req.query);
    if (error) return res.status(400).json({ error: { message: error, status: 400 } });

    if (!process.env.SERPAPI_KEY) {
      return unavailable(res, 503, 'not_configured',
        'Live flight search is not set up on this server (SERPAPI_KEY is missing), so no flights can be shown.', search);
    }

    try {
      res.json(await liveSearch(search));
    } catch (err) {
      // Bad key, rate limit, outage, unsupported airport, malformed response:
      // say the search failed. SerpApi's own message and reply (err.details)
      // are for server-side debugging only — never sent to the browser.
      console.warn('[flights] SerpApi call failed:', err.message);
      if (err.details) console.warn('[flights] SerpApi error details:', err.details);
      return unavailable(res, 502, 'provider_error',
        'Live flight prices could not be retrieved right now. No flights are shown rather than guessed ones — please try again.', search);
    }
  } catch (err) {
    next(err);
  }
});

const legKey = (n) => String(n || '').replace(/[\s-]/g, '').toUpperCase();

/**
 * GET /api/flights/booking-options
 * Query params: the same search params as /search (origin, destination,
 * date / departureDate, ...), plus either
 *   token (or bookingToken) — the itinerary's bookingToken from /search, or
 *   flights ("6E1301,QR273") and departureTime? ("21:10") — to find that
 *   itinerary in the same search first (served from the 5-minute search cache
 *   when the rider has just searched, so usually no extra SerpApi request).
 *
 * Who sells one itinerary and at what price, as Google Flights lists it —
 * the airline's own fare (e.g. Qatar Airways ₹29,134) next to agents' fares
 * (e.g. MakeMyTrip ₹27,005). Costs one SerpApi search, so the page only calls
 * it when the rider clicks Book Now; answers are cached for 5 minutes.
 */
router.get('/booking-options', flightsLimiter, async (req, res, next) => {
  try {
    const { search, error } = parseFlightSearch(req.query);
    if (error) return res.status(400).json({ error: { message: error, status: 400 } });

    const fail = (status, reason, message) =>
      res.status(status).json({ error: { message, status, reason }, options: [], airlineOption: null, cheapestOption: null, meta: { source: 'unavailable' } });

    const rawToken = req.query.token || req.query.bookingToken;
    let bookingToken = typeof rawToken === 'string' ? rawToken.trim() : '';
    const legs = String(req.query.flights || '').split(',').map(legKey).filter((n) => /^[A-Z0-9]{2}\d+$/.test(n)).slice(0, 8);
    if (bookingToken.length > 4096 || (!bookingToken && !legs.length)) {
      return res.status(400).json({ error: { message: 'A "token" from the flight search results, or the itinerary\'s "flights", is required.', status: 400 } });
    }
    if (bookingToken && !BOOKING_TOKEN_PATTERN.test(bookingToken)) {
      return res.status(400).json({ error: { message: 'The "token" is not a valid booking token from the flight search results.', status: 400 } });
    }
    // Airline names only steer which offer counts as the airline's own; anything
    // overlong or with control characters is dropped rather than passed on.
    let airlines = String(req.query.airlines || '').split(',').map((a) => a.trim())
      .filter((a) => a && a.length <= MAX_AIRLINE_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(a)).slice(0, 10);

    if (!process.env.SERPAPI_KEY) {
      return fail(503, 'not_configured', 'Live booking options are not set up on this server (SERPAPI_KEY is missing).');
    }

    if (!bookingToken) {
      // Find the itinerary by its flight numbers (and departure time, if given).
      let found;
      try {
        const { results } = await liveSearch(search);
        const time = String(req.query.departureTime || '').slice(0, 5);
        found = results.find((f) => f.bookingToken && (f.flightNumbers || []).map(legKey).join() === legs.join() &&
          (!/^\d{2}:\d{2}$/.test(time) || f.departureTime === time));
      } catch (err) {
        console.warn('[flights] SerpApi search for booking options failed:', err.message);
        if (err.details) console.warn('[flights] SerpApi error details:', err.details);
        return fail(502, 'provider_error', 'Booking options could not be retrieved right now. Please try again.');
      }
      if (!found) return fail(404, 'not_found', 'That flight is no longer in the live results for this search, so its booking options are not available.');
      bookingToken = found.bookingToken;
      if (!airlines.length) airlines = found.airlines || [];
    }

    const cacheKey = JSON.stringify({ bookingOptions: bookingToken, search, airlines });
    const cached = getCached(cacheKey);
    if (cached) return res.json({ ...cached, meta: { ...cached.meta, cached: true } });

    let mapped;
    try {
      const response = await getGoogleFlightsBookingOptions({ ...search, bookingToken });
      mapped = mapBookingOptions(response, airlines);
    } catch (err) {
      console.warn('[flights] SerpApi booking options failed:', err.message);
      if (err.details) console.warn('[flights] SerpApi error details:', err.details);
      return fail(502, 'provider_error', 'Booking options could not be retrieved right now. Please try again.');
    }

    const payload = {
      options: mapped.options,
      airlineOption: mapped.airlineOption,
      cheapestOption: mapped.cheapestOption,
      meta: {
        ...search,
        count: mapped.options.length,
        unsupportedCount: mapped.unsupportedCount,
        currency: mapped.currency,
        priceBasis: 'total_for_all_passengers',
        source: 'live',
        retrievedAt: new Date().toISOString(),
        cached: false
      }
    };
    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.latestSearchDate = latestSearchDate;
