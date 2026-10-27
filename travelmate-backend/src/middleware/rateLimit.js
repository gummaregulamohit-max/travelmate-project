// Per-client request limits for the routes that can spend paid API credits
// (SerpApi searches, IRCTC lookups). A fixed one-minute window per client IP,
// kept in memory — enough for a single local / small server process; use a
// shared store (e.g. Redis) if several processes ever serve the same users.
//
// Limits come from the environment, so local development can raise them:
//   FLIGHT_RATE_LIMIT_PER_MINUTE  (default 60)  /api/flights/search + /booking-options
//   TRAIN_RATE_LIMIT_PER_MINUTE   (default 120) /api/trains/search + /schedule
// A city train search fans out to up to 9 station-pair requests, hence the
// higher train default. A value that isn't a whole number >= 1 falls back to
// the default, with a warning — the limit can't be switched off by mistake.
//
// Memory is bounded: at most MAX_TRACKED_CLIENTS clients are remembered per
// limiter (expired windows are dropped first, then the oldest window).
// Refusals are logged once per client per window, without the client's
// address or the URL.
//
// Deployment (see "Deploying" in README.md): behind a reverse proxy every
// request comes from the proxy's address until Express's "trust proxy" is set,
// so all users would share one bucket; with several instances each keeps its
// own counts, so the effective limit multiplies. Per-client limits also don't
// cap total spend — many clients each get their own allowance.

const WINDOW_MS = 60 * 1000;
const MAX_TRACKED_CLIENTS = 10000;

const warned = new Set();
function parseLimit(raw, fallback, envName) {
  const text = raw == null ? '' : String(raw).trim();
  if (text === '') return fallback;
  if (/^\d+$/.test(text) && parseInt(text, 10) >= 1) return parseInt(text, 10);
  if (!warned.has(`${envName}=${text}`)) console.warn(`[rate-limit] ${envName}="${text}" is not a whole number of at least 1 — using ${fallback}.`);
  warned.add(`${envName}=${text}`);
  return fallback;
}

/**
 * Express middleware allowing `max()` requests per client IP per window.
 * `max` is a function so the limit is read from the environment on each
 * request (tests and config changes take effect without a restart).
 * `body(req)` is the JSON sent with a 429 — each route keeps its own shape.
 */
function createRateLimiter({ name, max, body, windowMs = WINDOW_MS, maxClients = MAX_TRACKED_CLIENTS }) {
  // client -> { count, resetAt, warned }. Kept in window-start order (a client
  // starting a new window moves to the end), so expired windows are always at
  // the front and the first entry is the oldest.
  const hits = new Map();

  function dropExpired(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt > now) break;
      hits.delete(key);
    }
  }

  function limiter(req, res, next) {
    const now = Date.now();
    const limit = max();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.delete(key);
      dropExpired(now);
      // However many clients appear within one window, memory stays bounded:
      // when the table is full, the client whose window started first is forgotten.
      if (hits.size >= maxClients) hits.delete(hits.keys().next().value);
      entry = { count: 0, resetAt: now + windowMs, warned: false };
      hits.set(key, entry);
    }
    entry.count += 1;

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    res.set('RateLimit-Reset', String(retryAfter));
    if (entry.count <= limit) return next();

    // Once per client per window — a client hammering the API can't flood the log.
    if (!entry.warned) {
      entry.warned = true;
      console.warn(`[rate-limit] ${name}: limit of ${limit}/min reached for a client — answering 429 until its window ends.`);
    }
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json(body(req, retryAfter));
  }
  limiter.reset = () => hits.clear(); // test hook
  limiter.size = () => hits.size; // test hook
  return limiter;
}

const message = (what, seconds) => `Too many ${what} from this device right now. Please wait about ${seconds} seconds and try again.`;

// SerpApi: /api/flights/search and /api/flights/booking-options together.
const flightsLimiter = createRateLimiter({
  name: 'flights',
  max: () => parseLimit(process.env.FLIGHT_RATE_LIMIT_PER_MINUTE, 60, 'FLIGHT_RATE_LIMIT_PER_MINUTE'),
  body: (req, seconds) => ({
    error: { message: message('flight searches', seconds), status: 429, reason: 'rate_limited' },
    results: [], options: [], airlineOption: null, cheapestOption: null,
    meta: { source: 'unavailable', count: 0, retryAfterSeconds: seconds }
  })
});

// IRCTC (when its request budget is on) and erail.in: /api/trains/search and /schedule.
const trainsLimiter = createRateLimiter({
  name: 'trains',
  max: () => parseLimit(process.env.TRAIN_RATE_LIMIT_PER_MINUTE, 120, 'TRAIN_RATE_LIMIT_PER_MINUTE'),
  body: (req, seconds) => ({
    error: { message: message('train searches', seconds), status: 429, reason: 'rate_limited' },
    results: [],
    meta: { source: 'unavailable', count: 0, retryAfterSeconds: seconds }
  })
});

module.exports = { createRateLimiter, parseLimit, flightsLimiter, trainsLimiter, WINDOW_MS, MAX_TRACKED_CLIENTS };
