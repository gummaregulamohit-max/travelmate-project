const axios = require('axios');

const SERPAPI_BASE_URL = 'https://serpapi.com/search';

class SerpApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'SerpApiError';
    this.status = status || 502;
    this.details = details;
  }
}

// SerpApi's travel_class codes. The frontend sends "PREMIUM-ECONOMY".
const TRAVEL_CLASS_CODES = { ECONOMY: 1, PREMIUM_ECONOMY: 2, BUSINESS: 3, FIRST: 4 };

function travelClassCode(cabinClass) {
  const key = String(cabinClass || 'ECONOMY').toUpperCase().replace(/[\s-]+/g, '_');
  return TRAVEL_CLASS_CODES[key] || TRAVEL_CLASS_CODES.ECONOMY;
}

/**
 * Calls SerpApi's Google Flights engine.
 * https://serpapi.com/google-flights-api
 *
 * `gl: 'in'` searches as a visitor from India. Without it SerpApi uses its
 * default (US) point of sale, which Google can price differently from the
 * google.co.in search a rider compares against. Passenger counts and cabin
 * are sent so the fare is for the search the rider actually made; the price
 * Google returns is the total for all of those passengers.
 *
 * SERPAPI_DEEP_SEARCH=true asks SerpApi for the slower "deep search", which
 * it documents as matching the browser's Google Flights results more closely.
 *
 * @param {{origin: string, destination: string, departureDate: string, returnDate?: string,
 *          currency?: string, adults?: number, children?: number, infants?: number, cabinClass?: string}} params
 * @returns {Promise<object>} raw SerpApi JSON — expected to contain best_flights / other_flights
 */
async function searchGoogleFlights({
  origin, destination, departureDate, returnDate, currency = 'INR',
  adults = 1, children = 0, infants = 0, cabinClass = 'ECONOMY'
}) {
  const params = searchParams({ origin, destination, departureDate, returnDate, currency, adults, children, infants, cabinClass });
  if (process.env.SERPAPI_DEEP_SEARCH === 'true') params.deep_search = true;
  return requestSerpApi(params, 'SerpApi Google Flights search failed.');
}

/**
 * The booking options Google Flights lists for one itinerary — who sells it
 * (the airline itself, or an agent such as MakeMyTrip) and at what price.
 * One SerpApi search per call: SerpApi needs the same search parameters plus
 * the itinerary's booking_token from the search results.
 *
 * @param {{bookingToken: string} & Parameters<typeof searchGoogleFlights>[0]} params
 * @returns {Promise<object>} raw SerpApi JSON — expected to contain booking_options
 */
async function getGoogleFlightsBookingOptions({ bookingToken, ...search }) {
  const params = searchParams({ currency: 'INR', ...search });
  params.booking_token = bookingToken;
  return requestSerpApi(params, 'SerpApi booking options request failed.');
}

// The google_flights parameters shared by a search and a booking-options request.
function searchParams({
  origin, destination, departureDate, returnDate, currency = 'INR',
  adults = 1, children = 0, infants = 0, cabinClass = 'ECONOMY'
}) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new SerpApiError('SerpApi key is not configured on the server. Set SERPAPI_KEY in .env.', 500);
  }

  const params = {
    engine: 'google_flights',
    departure_id: origin,
    arrival_id: destination,
    outbound_date: departureDate,
    currency,
    hl: 'en',
    gl: 'in',
    adults,
    travel_class: travelClassCode(cabinClass),
    api_key: apiKey
  };
  if (children) params.children = children;
  if (infants) params.infants_on_lap = infants;

  // SerpApi's google_flights engine requires `type` to disambiguate one-way
  // vs round trip, and round trip additionally requires return_date.
  if (returnDate) {
    params.type = 1; // Round trip
    params.return_date = returnDate;
  } else {
    params.type = 2; // One way
  }
  return params;
}

async function requestSerpApi(params, failureMessage) {
  try {
    const response = await axios.get(SERPAPI_BASE_URL, { params, timeout: 20000 });

    // Google Flights searched and found nothing: SerpApi still sets `error`
    // ("Google Flights hasn't returned any results for this query.") but marks
    // the search state as "Fully empty". That is a genuine live "no flights",
    // not a failure, so it is returned (as no flights) instead of thrown — a
    // throw would report a failed search rather than "no flights that day".
    if (response.data?.search_information?.flights_results_state === 'Fully empty') {
      return { ...response.data, best_flights: [], other_flights: [] };
    }

    // SerpApi returns HTTP 200 with an `error` field on the body for bad
    // requests (invalid API key, unknown airport code, etc.) rather than a
    // 4xx — check for it explicitly instead of assuming success.
    if (response.data?.error) {
      console.error('[serpapi] API returned an error:', response.data.error);
      throw new SerpApiError(response.data.error, 502, response.data);
    }

    // Guard against a 200 response that's missing the shape we expect
    // entirely (e.g. an unexpected SerpApi response format, a proxy/CDN
    // error page served with a 200, etc.) — never hand back something
    // callers might crash on trying to read `.flights` off of.
    if (!response.data || typeof response.data !== 'object') {
      throw new SerpApiError('SerpApi returned an unexpected (empty or non-JSON) response.', 502, response.data);
    }

    return response.data;
  } catch (err) {
    if (err instanceof SerpApiError) throw err;
    const status = err.response?.status || 502;
    const apiErrorMessage = err.response?.data?.error;
    if (apiErrorMessage) {
      console.error('[serpapi] API returned an error:', apiErrorMessage);
    }
    throw new SerpApiError(
      apiErrorMessage || failureMessage,
      status,
      err.response?.data ?? err.message
    );
  }
}

module.exports = { searchGoogleFlights, getGoogleFlightsBookingOptions, SerpApiError, travelClassCode };
