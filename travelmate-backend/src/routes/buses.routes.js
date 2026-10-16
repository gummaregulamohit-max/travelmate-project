const express = require('express');
const router = express.Router();

const { generateMockBuses } = require('../utils/mockBusGenerator');
const { normalizeDateToISO } = require('../utils/requestNormalizers');

function normalizeCity(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length ? trimmed : null;
}

const SIMULATED_NOTICE = 'Simulated schedules and fares for planning only — not live inventory. Check the operator or redBus for real buses and seats.';

/**
 * GET /api/buses/search?from=<city>&to=<city>&date=<YYYY-MM-DD>
 *
 * Generates 6-10 simulated intercity buses for the given city pair, covering
 * both government RTCs (KSRTC, TSRTC, APSRTC, MSRTC) and private operators
 * (VRL, Orange, SRS, Zingbus, IntrCity SmartBus). There's no live bus API
 * wired up, so results are always simulated (meta.source "simulated", each
 * result `simulated: true`) — stable per route/date rather than
 * re-randomizing on every request, with no seat counts and a link to where
 * real buses can be checked.
 */
router.get('/search', (req, res, next) => {
  try {
    const from = normalizeCity(req.query.from);
    const to = normalizeCity(req.query.to);
    const date = normalizeDateToISO(req.query.date);

    if (!from) {
      return res.status(400).json({ error: { message: 'A valid "from" city is required.', status: 400 } });
    }
    if (!to) {
      return res.status(400).json({ error: { message: 'A valid "to" city is required.', status: 400 } });
    }
    if (from.toLowerCase() === to.toLowerCase()) {
      return res.status(400).json({ error: { message: 'Origin and destination cannot be the same city.', status: 400 } });
    }
    if (!date) {
      return res.status(400).json({ error: { message: 'A valid "date" is required, as YYYY-MM-DD or DD-MM-YYYY.', status: 400 } });
    }

    const results = generateMockBuses({ from, to, date });

    res.json({ results, meta: { from, to, date, count: results.length, source: 'simulated', notice: SIMULATED_NOTICE } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
