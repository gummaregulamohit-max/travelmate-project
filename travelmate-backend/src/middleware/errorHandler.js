// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Defensive even here: an error handler that itself throws (e.g. on a
  // non-Error being passed to next()) takes the whole server down with it.
  const message = err?.message || 'Something went wrong while searching for flights.';
  const status = err?.status || 500;

  console.error('[flights api error]', message, err?.details ?? '');

  res.status(status).json({
    error: { message, status }
  });
}

module.exports = { errorHandler };
