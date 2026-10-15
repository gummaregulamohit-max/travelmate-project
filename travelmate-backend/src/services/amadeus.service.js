const axios = require('axios');

const AMADEUS_ENV = process.env.AMADEUS_ENV === 'production' ? 'production' : 'test';
const BASE_URL = AMADEUS_ENV === 'production'
  ? 'https://api.amadeus.com'
  : 'https://test.api.amadeus.com';

// Amadeus client-credentials tokens last ~30 min (expires_in is in seconds).
// Cached in memory — fine for a single-process server; swap for Redis if you scale out.
let cachedToken = null;
let tokenExpiresAt = 0;

class AmadeusApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'AmadeusApiError';
    this.status = status || 502;
    this.details = details;
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 30000) {
    return cachedToken;
  }

  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AmadeusApiError(
      'Amadeus API credentials are not configured on the server. Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET.',
      500
    );
  }

  try {
    const response = await axios.post(
      `${BASE_URL}/v1/security/oauth2/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    cachedToken = response.data.access_token;
    tokenExpiresAt = now + response.data.expires_in * 1000;
    return cachedToken;
  } catch (err) {
    throw new AmadeusApiError(
      'Failed to authenticate with the Amadeus API. Check your API key/secret and environment (test vs production).',
      err.response ? err.response.status : 502,
      err.response ? err.response.data : err.message
    );
  }
}

/**
 * Calls Amadeus Flight Offers Search (v2).
 * params: { origin, destination, date, returnDate?, adults, children?, infants?, cabinClass? }
 * Returns the raw Amadeus JSON: { data: [...offers], dictionaries: {...} }
 */
async function searchFlightOffers(params, { retry = true } = {}) {
  const token = await getAccessToken();

  const query = {
    originLocationCode: params.origin,
    destinationLocationCode: params.destination,
    departureDate: params.date,
    adults: params.adults || 1,
    max: params.max || 15,
    currencyCode: params.currencyCode || 'INR'
  };
  if (params.returnDate) query.returnDate = params.returnDate;
  if (params.children) query.children = params.children;
  if (params.infants) query.infants = params.infants;
  if (params.cabinClass) query.travelClass = params.cabinClass;

  try {
    const response = await axios.get(`${BASE_URL}/v2/shopping/flight-offers`, {
      headers: { Authorization: `Bearer ${token}` },
      params: query,
      timeout: 15000
    });
    return response.data;
  } catch (err) {
    const status = err.response ? err.response.status : 502;

    // Token may have expired right between our cache check and the request — retry once.
    if (status === 401 && retry) {
      cachedToken = null;
      return searchFlightOffers(params, { retry: false });
    }

    const amadeusMessage =
      err.response && err.response.data && err.response.data.errors && err.response.data.errors[0]
        ? err.response.data.errors[0].detail || err.response.data.errors[0].title
        : null;

    throw new AmadeusApiError(
      amadeusMessage || (status === 400 ? 'Invalid search parameters.' : 'Amadeus flight search failed.'),
      status,
      err.response ? err.response.data : err.message
    );
  }
}

module.exports = { searchFlightOffers, AmadeusApiError };
