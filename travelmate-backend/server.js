// .env is read from this folder, whatever directory the server is started
// from. dotenv never overrides a variable already set in the environment, so
// a rotated key in .env only takes effect if no old SERPAPI_KEY is set there.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const flightsRouter = require('./src/routes/flights.routes');
const trainsRouter = require('./src/routes/trains.routes');
const locationsRouter = require('./src/routes/locations.routes');
const busesRouter = require('./src/routes/buses.routes');
const healthRouter = require('./src/routes/health.routes');
const { warmUp: warmUpLocations } = require('./src/services/locations.service');
const { errorHandler, redactUrl } = require('./src/middleware/errorHandler');
const { apiOriginGuard, corsOptions } = require('./src/middleware/originPolicy');
const { ensureLocalKey } = require('./src/utils/localKey');
const { travelDateOverrideIgnored } = require('./src/utils/requestNormalizers');

const app = express();

app.use(express.json());

// Logs every incoming request with a timestamp — useful for confirming
// whether a browser request actually reached this server at all (vs. a
// client-side "Failed to fetch" that never got here in the first place).
// Booking tokens and any key-like query values are redacted (redactUrl).
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${redactUrl(req.originalUrl)}`);
  next();
});

// The API answers only the TravelMate app (same origin) and the listed
// localhost origins — see src/middleware/originPolicy.js. Refused requests
// get a 403 before any route, provider call or rate-limit count.
app.use('/api', apiOriginGuard, cors(corsOptions));

// The TravelMate app itself (TravelMate.html in the project root), served
// here so its API requests are same-origin: open http://localhost:<PORT>/.
// On the way out it gets a marker in <head> telling the page to call the API
// on its own origin, whatever the host or PORT. Opened any other way (as a
// file, or from another static server) the page has no marker and calls
// http://localhost:3000 — see TM_API_BASE in TravelMate.html.
const FRONTEND_FILE = path.join(__dirname, '..', 'TravelMate.html');
const API_BASE_MARKER = '<meta name="travelmate-api-base" content="same-origin">';
app.get(['/', '/TravelMate.html'], (req, res, next) => {
  fs.readFile(FRONTEND_FILE, 'utf8', (err, html) => {
    if (err) {
      console.error('[app] Could not read TravelMate.html:', err.code);
      return next(Object.assign(new Error('The TravelMate app could not be loaded.'), { status: 500 }));
    }
    // The first <head> is the document's own (a later one sits inside a script string).
    res.type('html').send(html.replace('<head>', `<head>\n${API_BASE_MARKER}`));
  });
});

// travelmate-local-key.js, next to TravelMate.html, holds the key that lets
// the page opened as a file use the API (src/utils/localKey.js). The page asks
// for it by that name however it is opened; served from here it gets an empty
// script — never the key, which any website could read with a <script> tag.
const LOCAL_KEY_FILE = process.env.TRAVELMATE_LOCAL_KEY_FILE || path.join(__dirname, '..', 'travelmate-local-key.js');
const localKeyReady = Boolean(ensureLocalKey(LOCAL_KEY_FILE));
app.get('/travelmate-local-key.js', (req, res) => {
  res.type('js').send('// Served by the backend, TravelMate needs no key.\n');
});

// public/index.html — an older copy of the frontend, kept on disk for reference
// — is deliberately not served: nothing links to it, and it predates the
// escaping of provider data in the cards. /index.html is a plain 404.

app.use('/api/flights', flightsRouter);
app.use('/api/trains', trainsRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/buses', busesRouter);
app.use('/api/health', healthRouter);

// 404 for unmatched API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: { message: 'Not found.', status: 404 } });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
// Loopback only by default: reachable from this computer, not from other
// devices on the network. Set HOST (e.g. 0.0.0.0) only for a deployment, and
// then set ALLOWED_ORIGINS to the site's own origin too.
const HOST = (process.env.HOST || '').trim() || '127.0.0.1';
const LOOPBACK = HOST === 'localhost' || HOST === '::1' || /^127\./.test(HOST);
app.listen(PORT, HOST, () => {
  console.log(`TravelMate backend listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
  console.log(`➡️  Open the TravelMate app at http://localhost:${PORT}/`);
  if (localKeyReady) console.log('✅ TravelMate.html opened as a file can use the API too (key in travelmate-local-key.js).');
  if (travelDateOverrideIgnored()) console.warn('⚠️  TRAVELMATE_TODAY is set but ignored: it only applies when NODE_ENV=test. Travel dates are checked against the real date.');
  if (!LOOPBACK) console.warn(`⚠️  HOST=${HOST}: the server is reachable from other devices on the network. Set ALLOWED_ORIGINS for the site that should use it.`);
  // Index the city / town / village directory up front so the first autocomplete
  // request doesn't pay for it.
  setImmediate(() => {
    try {
      const stats = warmUpLocations();
      console.log(`✅ Location directory ready — ${stats.places} places (${stats.cities} cities, ${stats.towns} towns, ${stats.villages} villages).`);
    } catch (err) {
      console.warn('⚠️  Could not build the location directory:', err.message);
    }
  });
  if (process.env.SERPAPI_KEY) {
    console.log('✅ SERPAPI_KEY is set — live Google Flights search is active.');
  } else {
    console.warn('⚠️  SERPAPI_KEY is not set — flight searches will return an error (no flights) until it is set in .env.');
  }
  if (process.env.RAPIDAPI_KEY) {
    // Reads the local usage file only — no request is sent at startup.
    const { MAX_LOOKUPS_PER_SEARCH, requestBudgetStatus } = require('./src/services/irctc.service');
    const quota = requestBudgetStatus();
    if (!quota.enabled) {
      console.log('ℹ️  RAPIDAPI_KEY is set, but live Indian Railway IRCTC requests are OFF (TRAIN_API_REQUEST_BUDGET is 0 or unset) — trains use the public erail.in timetable only (the IRCTC cache is in memory and starts empty, and nothing is added to it while requests are off).');
    } else {
      console.log(`✅ Live Indian Railway IRCTC requests are on: ${quota.requestsSent} of ${quota.budget} budgeted requests sent (up to ${MAX_LOOKUPS_PER_SEARCH} per search).`);
      console.log(quota.configuredPeriod
        ? `ℹ️  IRCTC budget period: ${quota.configuredPeriod.start} to ${quota.configuredPeriod.end} (TRAIN_API_QUOTA_RESET_DATE).`
        : 'ℹ️  TRAIN_API_QUOTA_RESET_DATE is not set — the IRCTC request count restarts only by a manual reset (npm run irctc:usage).');
    }
    if (quota.resetDateMismatch) console.warn(`⚠️  RapidAPI reported its quota resets at ${quota.provider.resetAt}, more than a day from the configured period end — check TRAIN_API_QUOTA_RESET_DATE.`);
    if (quota.blockedUntil) console.warn(`⚠️  IRCTC requests are blocked (${quota.blockReason}) until ${quota.blockedUntil}.`);
    if (quota.provider) console.log(`ℹ️  RapidAPI last reported ${quota.provider.remaining} requests left (at ${quota.provider.observedAt}).`);
  } else {
    console.warn('⚠️  RAPIDAPI_KEY is not set — train search falls back to the public erail.in timetable, without IRCTC-verified timings. Set it in .env.');
  }
  if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET) {
    console.log('ℹ️  AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET are not set — this is fine, Amadeus is not currently used (SerpApi is the active provider).');
  }
});
