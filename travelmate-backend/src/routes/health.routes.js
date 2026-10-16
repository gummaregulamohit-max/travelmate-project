const express = require('express');
const router = express.Router();

const { version } = require('../../package.json');

/**
 * GET /api/health
 *
 * Liveness check: answers from memory without calling any external API, so it
 * costs no SerpApi / RapidAPI quota.
 *
 *   { status: "ok", version, uptimeSeconds, timestamp,
 *     providers: {
 *       flights: { provider, configured, fallback },
 *       trains:  { provider, configured, fallback },
 *       buses:   { provider, configured, fallback } } }
 *
 * `configured` only says whether a provider's key is set — never the key, its
 * length or any part of it.
 */
router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    version,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    providers: {
      flights: { provider: 'SerpApi (Google Flights)', configured: Boolean(process.env.SERPAPI_KEY), fallback: 'mock' },
      trains: { provider: 'Indian Railway IRCTC (RapidAPI)', configured: Boolean(process.env.RAPIDAPI_KEY), fallback: 'erail.in timetable' },
      buses: { provider: 'simulated', configured: true, fallback: null }
    }
  });
});

module.exports = router;
