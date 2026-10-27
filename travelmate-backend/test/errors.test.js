const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const express = require('express');
const { startServer } = require('./helpers/server');

const ROOT = path.join(__dirname, '..');
const { errorHandler, apiArea, redactUrl, isProviderError } = require(path.join(ROOT, 'src/middleware/errorHandler'));

// --- Real server: requests that match no route -----------------------------

let server;
before(async () => { server = await startServer(); });
after(() => server.stop());

test('an unknown API route is a JSON 404', async () => {
  for (const p of ['/api/does-not-exist', '/api/trains/nope', '/api/locations/nope', '/api/buses/nope']) {
    const { status, body } = await server.get(p);
    assert.equal(status, 404, `status for ${p}`);
    assert.deepEqual(body, { error: { message: 'Not found.', status: 404 } });
  }
});

test('a wrong HTTP method on a search route is a JSON 404', async () => {
  const { status, body } = await server.request('/api/locations/search?q=Mumbai', { method: 'POST' });
  assert.equal(status, 404);
  assert.equal(body.error.status, 404);
});

test('a malformed JSON body is a 400 from the error handler, not a crash', async () => {
  const { status, body } = await server.request('/api/locations/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json'
  });
  assert.equal(status, 400);
  assert.equal(body.error.status, 400);
  // The server must still answer afterwards.
  assert.equal((await server.get('/api/trains/stations?q=CSMT')).status, 200);
});

// --- errorHandler on its own, behind a throwaway app ----------------------
// No real route can be made to fail without changing source, so these mount
// the real middleware behind routes that fail on purpose.

async function hit(failingRoute, urlPath = '/fail') {
  // Mounted through a router like the real ones, so req.baseUrl handling matches.
  const router = express.Router();
  router.get('/fail', failingRoute);
  const app = express();
  app.use(urlPath.split('?')[0].replace(/\/fail$/, '') || '/', router);
  app.use(errorHandler);
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${urlPath}`);
    return { status: res.status, body: await res.json() };
  } finally {
    srv.close();
  }
}

test('errorHandler: an Error passed to next() is a 500 with its message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { status, body } = await hit((req, res, next) => next(new Error('boom')));
  assert.equal(status, 500);
  assert.deepEqual(body, { error: { message: 'boom', status: 500 } });
});

test('errorHandler: an error thrown synchronously in a route is a 500', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { status, body } = await hit(() => { throw new Error('sync boom'); });
  assert.equal(status, 500);
  assert.equal(body.error.message, 'sync boom');
});

test('errorHandler: an error with a status keeps that status', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { status, body } = await hit((req, res, next) => next(Object.assign(new Error('Upstream timed out'), { status: 504 })));
  assert.equal(status, 504);
  assert.deepEqual(body, { error: { message: 'Upstream timed out', status: 504 } });
});

test('errorHandler: a non-Error value still gets a JSON 500', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { status, body } = await hit((req, res, next) => next({}));
  assert.equal(status, 500);
  assert.equal(body.error.status, 500);
  assert.equal(typeof body.error.message, 'string');
});

test('errorHandler: logs the error', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  await hit((req, res, next) => next(new Error('boom')));
  assert.equal(logged.mock.callCount(), 1);
});

// --- errorHandler names the area the error came from ----------------------

test('errorHandler: the fallback message names the route area, not always flights', async (t) => {
  t.mock.method(console, 'error', () => {});
  const expected = {
    '/api/flights/fail': 'Something went wrong while searching for flights.',
    '/api/trains/fail': 'Something went wrong while searching for trains.',
    '/api/locations/fail?q=Mumbai': 'Something went wrong while looking up locations.',
    '/api/buses/fail': 'Something went wrong while searching for buses.',
    '/api/other/fail': 'Something went wrong on the server.',
    '/fail': 'Something went wrong on the server.'
  };
  for (const [urlPath, message] of Object.entries(expected)) {
    const { status, body } = await hit((req, res, next) => next({}), urlPath);
    assert.equal(status, 500, urlPath);
    assert.deepEqual(body, { error: { message, status: 500 } }, urlPath);
  }
});

test('errorHandler: an error message of its own is kept on every route', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { body } = await hit((req, res, next) => next(new Error('Station lookup failed')), '/api/trains/fail');
  assert.equal(body.error.message, 'Station lookup failed');
});

test('errorHandler: the log line names the area and request, not "flights"', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  await hit((req, res, next) => next(new Error('boom')), '/api/trains/fail');
  const [label, method, url, message] = logged.mock.calls[0].arguments;
  assert.equal(label, '[trains api error]');
  assert.equal(method, 'GET');
  assert.equal(url, '/api/trains/fail');
  assert.equal(message, 'boom');
});

test('apiArea: reads the area from the original URL', () => {
  assert.equal(apiArea({ originalUrl: '/api/locations/search?q=x' }), 'locations');
  assert.equal(apiArea({ originalUrl: '/API/Trains/stations' }), 'trains');
  assert.equal(apiArea({ originalUrl: '/index.html' }), 'server');
  assert.equal(apiArea(undefined), 'server');
});

// --- provider errors never reach the browser in their own words ------------

test('errorHandler: a provider error that reaches it is answered with fixed text, and logged in full', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const serpApiError = Object.assign(new Error('Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key'),
    { name: 'SerpApiError', status: 502, details: { error: 'Invalid API key.' } });
  const { status, body } = await hit((req, res, next) => next(serpApiError), '/api/flights/fail');
  assert.equal(status, 502);
  assert.deepEqual(body, { error: { message: 'Something went wrong while searching for flights.', status: 502 } });
  assert.match(logged.mock.calls[0].arguments[3], /Invalid API key/);
});

test('errorHandler: an IRCTC error uses its fixed public message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const irctcError = Object.assign(new Error('provider said: quota exceeded for key ...'),
    { name: 'IrctcApiError', status: 429, publicMessage: 'The IRCTC (RapidAPI) plan has used up its request quota for now.' });
  const { status, body } = await hit((req, res, next) => next(irctcError), '/api/trains/fail');
  assert.equal(status, 429);
  assert.equal(body.error.message, 'The IRCTC (RapidAPI) plan has used up its request quota for now.');
});

test('errorHandler: an HTTP client error (e.g. a timeout calling a provider) is answered with fixed text', async (t) => {
  t.mock.method(console, 'error', () => {});
  const axiosError = Object.assign(new Error('getaddrinfo ENOTFOUND erail.in'), { isAxiosError: true });
  const { status, body } = await hit((req, res, next) => next(axiosError), '/api/trains/fail');
  assert.equal(status, 500);
  assert.equal(body.error.message, 'Something went wrong while searching for trains.');
});

test('isProviderError: only provider and HTTP-client errors', () => {
  assert.equal(isProviderError(Object.assign(new Error('x'), { name: 'SerpApiError' })), true);
  assert.equal(isProviderError(Object.assign(new Error('x'), { name: 'IrctcApiError' })), true);
  assert.equal(isProviderError({ isAxiosError: true }), true);
  assert.equal(isProviderError(new Error('Station lookup failed')), false);
  assert.equal(isProviderError(null), false);
});

// --- request URLs in logs ---------------------------------------------------

test('redactUrl: booking tokens and key-like values are hidden, the rest of the search is kept', () => {
  assert.equal(redactUrl('/api/flights/booking-options?token=abc123&origin=BLR&destination=AMS'),
    '/api/flights/booking-options?token=[redacted]&origin=BLR&destination=AMS');
  assert.equal(redactUrl('/x?bookingToken=a&booking_token=b&api_key=c&apiKey=d&key=e&access_token=f&password=g&secret=h'),
    '/x?bookingToken=[redacted]&booking_token=[redacted]&api_key=[redacted]&apiKey=[redacted]&key=[redacted]&access_token=[redacted]&password=[redacted]&secret=[redacted]');
  assert.equal(redactUrl('/api/trains/search?from=SBC&to=HYB&date=2026-10-30'), '/api/trains/search?from=SBC&to=HYB&date=2026-10-30');
  assert.equal(redactUrl('/api/locations/search?q=monkey'), '/api/locations/search?q=monkey', 'only whole parameter names match');
  assert.equal(redactUrl('/x?TOKEN=a'), '/x?TOKEN=[redacted]');
  assert.equal(redactUrl('/x?%74oken=a'), '/x?%74oken=[redacted]', 'encoded names are recognised');
  assert.equal(redactUrl('/x?token'), '/x?token=[redacted]');
  assert.equal(redactUrl('/api/health'), '/api/health');
  assert.equal(redactUrl(undefined), '');
});

test('errorHandler: the logged URL has its booking token redacted', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  await hit((req, res, next) => next(new Error('boom')), '/api/flights/fail?token=secret-booking-token&origin=BLR');
  const [, , url] = logged.mock.calls[0].arguments;
  assert.equal(url, '/api/flights/fail?token=[redacted]&origin=BLR');
});

test('server.js: the request log line goes through redactUrl', () => {
  const source = require('node:fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(source, /console\.log\(`\[\$\{new Date\(\)\.toISOString\(\)\}\] \$\{req\.method\} \$\{redactUrl\(req\.originalUrl\)\}`\)/);
  assert.doesNotMatch(source, /\$\{req\.originalUrl\}/);
});
