// Normalizes loosely-formatted request inputs before they hit validation or
// get forwarded to SerpApi. Both functions return `null` on anything they
// can't confidently normalize, so callers can treat null as "invalid input"
// uniformly.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/; // DD-MM-YYYY, e.g. "23-09-2026"

/**
 * Accepts "YYYY-MM-DD" as-is, or converts "DD-MM-YYYY" to "YYYY-MM-DD".
 * Returns null if the string matches neither shape.
 */
function normalizeDateToISO(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  if (ISO_DATE_RE.test(trimmed)) return trimmed;

  const dmy = DMY_DATE_RE.exec(trimmed);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
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

module.exports = { normalizeDateToISO, extractIataCode, extractStationCode };
