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

// Query parameters whose values never belong in a log line: flight booking
// tokens, and any key or credential a client might send by mistake.
const SENSITIVE_QUERY_PARAM = /^(token|booking_?token|api_?key|key|access_?token|password|secret)$/i;

/**
 * A request URL for logging, with sensitive query values replaced by
 * "[redacted]" — "/api/flights/booking-options?token=abc&origin=BLR" ->
 * "/api/flights/booking-options?token=[redacted]&origin=BLR". Everything else
 * is kept as sent, so the log still shows which search was made.
 */
function redactUrl(url) {
  const text = String(url ?? '');
  const q = text.indexOf('?');
  if (q === -1) return text;
  const query = text.slice(q + 1).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    let name = rawName;
    try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')); } catch { /* malformed: judged as sent */ }
    return SENSITIVE_QUERY_PARAM.test(name) ? `${rawName}=[redacted]` : pair;
  });
  return `${text.slice(0, q)}?${query.join('&')}`;
}

// An error raised by an outside provider (SerpApi, the IRCTC API, or an HTTP
// call to erail.in): its message is the provider's own text, kept for the log
// but never sent to the browser. Routes catch these themselves; this is the
// safety net for one that reaches the handler.
function isProviderError(err) {
  return Boolean(err) && (err.name === 'SerpApiError' || err.name === 'IrctcApiError' || err.isAxiosError === true);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Defensive even here: an error handler that itself throws (e.g. on a
  // non-Error being passed to next()) takes the whole server down with it.
  const area = apiArea(req);
  const fallback = FALLBACK_MESSAGES[area] || DEFAULT_MESSAGE;
  const logMessage = err?.message || fallback;
  // IrctcApiError carries a fixed publicMessage; other provider errors get the area's fallback.
  const message = isProviderError(err) ? (err.publicMessage || fallback) : logMessage;
  const status = err?.status || 500;

  console.error(`[${area} api error]`, req?.method, redactUrl(req?.originalUrl), logMessage, err?.details ?? '');

  res.status(status).json({
    error: { message, status }
  });
}

module.exports = { errorHandler, apiArea, redactUrl, isProviderError };
