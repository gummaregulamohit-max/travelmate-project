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

/**
 * Calls SerpApi's Google Flights engine.
 * https://serpapi.com/google-flights-api
 *
 * @param {{origin: string, destination: string, departureDate: string, returnDate?: string, currency?: string}} params
 * @returns {Promise<object>} raw SerpApi JSON — expected to contain best_flights / other_flights
 */
async function searchGoogleFlights({ origin, destination, departureDate, returnDate, currency = 'INR' }) {
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
    api_key: apiKey
  };

  // SerpApi's google_flights engine requires `type` to disambiguate one-way
  // vs round trip, and round trip additionally requires return_date.
  if (returnDate) {
    params.type = 1; // Round trip
    params.return_date = returnDate;
  } else {
    params.type = 2; // One way
  }

  try {
    const response = await axios.get(SERPAPI_BASE_URL, { params, timeout: 20000 });

    // SerpApi returns HTTP 200 with an `error` field on the body for bad
    // requests (invalid API key, unknown airport code, no results, etc.)
    // rather than a 4xx — check for it explicitly instead of assuming success.
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
      apiErrorMessage || 'SerpApi Google Flights search failed.',
      status,
      err.response?.data ?? err.message
    );
  }
}

module.exports = { searchGoogleFlights, SerpApiError };
