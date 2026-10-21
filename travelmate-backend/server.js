require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const flightsRouter = require('./src/routes/flights.routes');
const trainsRouter = require('./src/routes/trains.routes');
const locationsRouter = require('./src/routes/locations.routes');
const busesRouter = require('./src/routes/buses.routes');
const healthRouter = require('./src/routes/health.routes');
const { warmUp: warmUpLocations } = require('./src/services/locations.service');
const { errorHandler } = require('./src/middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

// Logs every incoming request with a timestamp — useful for confirming
// whether a browser request actually reached this server at all (vs. a
// client-side "Failed to fetch" that never got here in the first place).
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Serves the existing TravelMate frontend (public/index.html) so the whole
// app — UI + API — runs from a single server during development.
app.use(express.static(path.join(__dirname, 'public')));

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
app.listen(PORT, () => {
  console.log(`TravelMate backend listening on http://localhost:${PORT}`);
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
    console.warn('⚠️  SERPAPI_KEY is not set — falling back to mock flight data for every search. Set it in .env.');
  }
  if (process.env.RAPIDAPI_KEY) {
    // Reads the local usage file only — no request is sent at startup.
    const { MAX_LOOKUPS_PER_SEARCH, requestBudgetStatus } = require('./src/services/irctc.service');
    const quota = requestBudgetStatus();
    if (!quota.enabled) {
      console.log('ℹ️  RAPIDAPI_KEY is set, but live Indian Railway IRCTC requests are OFF (TRAIN_API_REQUEST_BUDGET is 0 or unset) — trains use the public timetable plus any cached IRCTC data.');
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
