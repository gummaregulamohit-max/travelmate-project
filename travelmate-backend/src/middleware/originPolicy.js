// Which web pages may use this server's API.
//
// The TravelMate app is served by this server (http://localhost:<PORT>/), so
// its own requests are same-origin. Other pages are refused, because a
// browser sends a request even when CORS later hides the answer — and every
// flight search spends a SerpApi credit. Allowed by default:
//   http://localhost:<PORT>  and  http://127.0.0.1:<PORT>
// ALLOWED_ORIGINS (comma-separated, exact origins such as
// "http://localhost:5500") replaces that list, e.g. for a deployed site.
// "Origin: null" — sent by pages opened as files (file://) and by sandboxed
// frames on any site — is never allowed, even if listed.

const { redactUrl } = require('./errorHandler');

const warned = new Set();
function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[origin] ${message}`);
}

function port() {
  return process.env.PORT || 3000;
}

function defaultOrigins() {
  return [`http://localhost:${port()}`, `http://127.0.0.1:${port()}`];
}

// "http(s)://host[:port]" entries only — no path, no wildcard, never "null".
function parseOriginList(raw) {
  const origins = new Set();
  for (const item of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (item.toLowerCase() === 'null') {
      warnOnce('ALLOWED_ORIGINS lists "null" — ignored: it would let pages opened as files and sandboxed frames on any site use the API.');
      continue;
    }
    let url = null;
    try { url = new URL(item); } catch { /* reported below */ }
    if (!url || !/^https?:$/.test(url.protocol) || url.origin !== item.replace(/\/$/, '')) {
      warnOnce(`ALLOWED_ORIGINS entry "${item.slice(0, 100)}" is not an origin like http://localhost:5500 — ignored.`);
      continue;
    }
    origins.add(url.origin);
  }
  return origins;
}

/** The allowed origins now (read from the environment on each call). */
function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw && raw.trim()) {
    const listed = parseOriginList(raw);
    if (listed.size) return listed;
    warnOnce('ALLOWED_ORIGINS has no valid entries — using the localhost defaults.');
  }
  return new Set(defaultOrigins());
}

function isAllowedOrigin(origin) {
  return typeof origin === 'string' && allowedOrigins().has(origin);
}

// A request without an Origin header passes only when the browser marks it as
// the app's own ("same-origin") or as started by the user ("none": a typed URL
// or a bookmark), or when it has no Sec-Fetch-Site at all (curl, scripts, the
// tests, older browsers). "same-site" is any other port on localhost — e.g. an
// <img> or no-cors fetch on a dev server at :5500 — and "cross-site" any other
// website; both are refused, as is any unexpected value. (A page's fetch()
// calls to another origin carry Origin, so they are judged by the list above.)
const NO_ORIGIN_ALLOWED_SITES = new Set(['', 'same-origin', 'none']);

/**
 * For /api: a 403 for a request a browser made from a page that isn't
 * allowed — an Origin header not on the list (including "null"), or no Origin
 * from anywhere but the app itself or the user (see NO_ORIGIN_ALLOWED_SITES).
 * Runs before the routes and their rate limits.
 */
function apiOriginGuard(req, res, next) {
  const origin = req.get('origin');
  const site = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (origin !== undefined ? isAllowedOrigin(origin) : NO_ORIGIN_ALLOWED_SITES.has(site)) return next();

  const from = origin !== undefined
    ? `origin ${JSON.stringify(String(origin).slice(0, 100))}`
    : `a ${JSON.stringify(site.slice(0, 20))} request without an Origin header`;
  console.warn(`[origin] Refused ${req.method} ${redactUrl(req.originalUrl)} from ${from}.`);
  return res.status(403).json({
    error: {
      message: `This API only answers the TravelMate app. Open it at http://localhost:${port()}/ (not as a file).`,
      status: 403,
      reason: 'origin_not_allowed'
    }
  });
}

/** Options for the cors package: CORS headers only for allowed origins. */
const corsOptions = {
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin))
};

module.exports = { apiOriginGuard, corsOptions, allowedOrigins, isAllowedOrigin, parseOriginList, defaultOrigins, NO_ORIGIN_ALLOWED_SITES };
