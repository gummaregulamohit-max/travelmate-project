// Normalizes loosely-formatted request inputs before they hit validation or
// get forwarded to SerpApi. Both functions return `null` on anything they
// can't confidently normalize, so callers can treat null as "invalid input"
// uniformly.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/; // DD-MM-YYYY, e.g. "23-09-2026"
const DAY_MS = 24 * 60 * 60 * 1000;

// True for a date that exists on the calendar ("2026-02-31" does not).
function isCalendarDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * The clock travel dates are checked against, in milliseconds: Date.now().
 * Only in the test environment (NODE_ENV=test, which the test suite sets) does
 * TRAVELMATE_TODAY=YYYY-MM-DD pin "today", so fixed test dates stay valid.
 * Anywhere else it is ignored — a stray setting can never move the date check
 * of a real deployment — and server.js warns at startup (see
 * travelDateOverrideIgnored). An invalid value is ignored too.
 */
function travelClockMs() {
  if (process.env.NODE_ENV === 'test') {
    const pinned = String(process.env.TRAVELMATE_TODAY || '').trim();
    if (ISO_DATE_RE.test(pinned) && isCalendarDate(pinned)) return Date.parse(`${pinned}T12:00:00Z`);
  }
  return Date.now();
}

/** True when TRAVELMATE_TODAY is set but not honoured, because NODE_ENV isn't "test". */
function travelDateOverrideIgnored() {
  return String(process.env.TRAVELMATE_TODAY || '').trim() !== '' && process.env.NODE_ENV !== 'test';
}

/**
 * The earliest travel date accepted, as YYYY-MM-DD (UTC): yesterday. One day
 * of slack, because "today" for a traveller (e.g. in IST, UTC+5:30, or in
 * UTC-10) can be yesterday or tomorrow in UTC.
 */
function earliestTravelDate(nowMs = travelClockMs()) {
  return new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
}

/**
 * A travel date from the query string, checked:
 *   { date: 'YYYY-MM-DD', error: null }  valid
 *   { date: null, error: 'invalid' }     missing, not YYYY-MM-DD / DD-MM-YYYY,
 *                                        or not a real calendar date
 *   { date: null, error: 'past', iso }   before earliestTravelDate() — unless
 *                                        `allowPast` is set
 */
function checkTravelDate(input, { allowPast = false } = {}) {
  if (!input || typeof input !== 'string') return { date: null, error: 'invalid' };
  const trimmed = input.trim();
  let iso = null;
  if (ISO_DATE_RE.test(trimmed)) {
    iso = trimmed;
  } else {
    const dmy = DMY_DATE_RE.exec(trimmed);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      iso = `${yyyy}-${mm}-${dd}`;
    }
  }
  if (!iso || !isCalendarDate(iso)) return { date: null, error: 'invalid' };
  if (!allowPast && iso < earliestTravelDate()) return { date: null, error: 'past', iso };
  return { date: iso, error: null };
}

/**
 * Accepts "YYYY-MM-DD" as-is, or converts "DD-MM-YYYY" to "YYYY-MM-DD".
 * Returns null if the string matches neither shape, is not a real calendar
 * date, or is a past travel date (see checkTravelDate; `allowPast` lifts that).
 */
function normalizeDateToISO(input, options) {
  return checkTravelDate(input, options).date;
}

// The 400 message for a travel date that checkTravelDate refused.
function travelDateMessage(check, name = 'date') {
  return check.error === 'past'
    ? `"${name}" (${check.iso}) is in the past — choose today or a later date.`
    : `A valid "${name}" is required, as YYYY-MM-DD or DD-MM-YYYY.`;
}

/**
 * Accepts a bare 3-letter IATA code ("BLR"), or pulls one out of a combobox-style
 * label like "Bangalore, Kempegowda International Airport (BLR)". Returns the
 * uppercased 3-letter code, or null if none can be found.
 */
function extractIataCode(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();

  const parenMatch = /\(([A-Za-z]{3})\)\s*$/.exec(trimmed);
  if (parenMatch) return parenMatch[1].toUpperCase();

  return null;
}

/**
 * Accepts a bare IRCTC station code ("MRK", "SBC", "SMVB"), or pulls one out of
 * a combobox-style label like "Markapur Road (MRK)". Returns the uppercased
 * code (1–5 letters), or null if none can be found.
 */
function extractStationCode(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  if (/^[A-Za-z]{1,5}$/.test(trimmed)) return trimmed.toUpperCase();

  const parenMatch = /\(([A-Za-z]{1,5})\)\s*$/.exec(trimmed);
  if (parenMatch) return parenMatch[1].toUpperCase();

  return null;
}

/**
 * A single query-string value as a trimmed string. Express turns a repeated
 * parameter (?q=a&q=b) into an array and ?q[x]=1 into an object; a repeated
 * parameter uses its first value, anything else that isn't a string is ''.
 */
function queryString(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A result-count limit. A whole number is clamped to 1..max (so 0 and
 * negatives give 1); a missing or non-numeric value gives `fallback`.
 */
function parseLimit(value, { fallback = 20, max = 100 } = {}) {
  const text = queryString(value);
  if (!/^-?\d+$/.test(text)) return fallback;
  return Math.min(Math.max(parseInt(text, 10), 1), max);
}

module.exports = {
  normalizeDateToISO, checkTravelDate, travelDateMessage, earliestTravelDate, travelClockMs, travelDateOverrideIgnored,
  extractIataCode, extractStationCode, queryString, parseLimit
};
