// Seat availability is never invented. The current train API (Indian Railway
// IRCTC on RapidAPI) offers no seat-status endpoint, so every class that isn't
// explicitly marked `live: true` by a real source is labelled as "check on
// IRCTC" instead of carrying a seat status of its own — including the
// hand-entered statuses in data/knownTrainRoutes.js, which are not live.

const IRCTC_SEAT_CHECK_URL = 'https://www.irctc.co.in/nget/train-search';
const SEAT_CHECK_STATUS = 'Check seats on IRCTC';

// Why a seat-availability lookup gave no live answer, as a code a client can
// branch on (the human-readable `message` goes alongside it).
const REASONS = {
  NOT_SUPPORTED: 'not_supported', // the provider has no seat-availability endpoint
  NOT_CONFIGURED: 'not_configured', // no RAPIDAPI_KEY on this server
  RATE_LIMITED: 'rate_limited', // the provider's quota or rate limit was hit
  NO_DATA: 'no_data', // the provider answered, but with nothing for this class
  PROVIDER_ERROR: 'provider_error' // the provider call failed for another reason
};

/** A class list in which only `live: true` classes keep a seat status. */
function withSeatCheck(classes) {
  if (!Array.isArray(classes)) return classes;
  return classes.map((c) => (c && c.live === true ? c : { ...c, status: SEAT_CHECK_STATUS, tier: 'unknown', live: false }));
}

/** The reason code for an error thrown by a seat-availability lookup. */
function availabilityReason(err) {
  if (err?.rateLimited) return REASONS.RATE_LIMITED;
  if (err?.status === 501) return REASONS.NOT_SUPPORTED;
  return REASONS.PROVIDER_ERROR;
}

module.exports = { IRCTC_SEAT_CHECK_URL, SEAT_CHECK_STATUS, REASONS, withSeatCheck, availabilityReason };
