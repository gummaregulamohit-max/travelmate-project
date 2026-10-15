// The fallback message for an error without one, by the /api/<area> it came from.
const FALLBACK_MESSAGES = {
  flights: 'Something went wrong while searching for flights.',
  trains: 'Something went wrong while searching for trains.',
  locations: 'Something went wrong while looking up locations.',
  buses: 'Something went wrong while searching for buses.'
};
const DEFAULT_MESSAGE = 'Something went wrong on the server.';

// "/api/trains/stations?q=x" -> "trains"; anything outside /api -> "server"
function apiArea(req) {
  const match = /^\/api\/([a-z]+)/i.exec(req?.originalUrl || '');
  return match ? match[1].toLowerCase() : 'server';
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Defensive even here: an error handler that itself throws (e.g. on a
  // non-Error being passed to next()) takes the whole server down with it.
  const area = apiArea(req);
  const message = err?.message || FALLBACK_MESSAGES[area] || DEFAULT_MESSAGE;
  const status = err?.status || 500;

  console.error(`[${area} api error]`, req?.method, req?.originalUrl, message, err?.details ?? '');

  res.status(status).json({
    error: { message, status }
  });
}

module.exports = { errorHandler, apiArea };
