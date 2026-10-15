const express = require('express');
const router = express.Router();

const { generateMockBuses } = require('../utils/mockBusGenerator');
const { normalizeDateToISO } = require('../utils/requestNormalizers');

function normalizeCity(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * GET /api/buses/search?from=<city>&to=<city>&date=<YYYY-MM-DD>
 *
 * Generates 6-10 realistic, dynamically scheduled intercity buses for the
 * given city pair, covering both government RTCs (KSRTC, TSRTC, APSRTC,
 * MSRTC) and private operators (VRL, Orange, SRS, Zingbus, IntrCity
 * SmartBus). Unlike flights/trains there's no live bus-schedule API wired
 * up here, so results are always the seeded "estimated" tier — but they're
 * stable per route/date rather than re-randomizing on every request.
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

    res.json({ results, meta: { from, to, date, count: results.length, source: 'estimated' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
