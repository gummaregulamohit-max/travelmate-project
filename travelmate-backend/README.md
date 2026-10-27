# TravelMate Backend

Active providers:

- **Flights** — real flight data via [SerpApi's Google Flights engine](https://serpapi.com/google-flights-api).
  There is no mock fallback: without SerpApi the search returns an error and no flights.
- **Trains** — the Indian Railway IRCTC API on RapidAPI verifies timetable
  trains, with the public erail.in timetable as fallback. Fares are fare-chart
  prices; live seat availability is not offered.
- **Buses** — simulated only (no live bus API); see `GET /api/buses/search`.
- **Locations and stations** — bundled data in `src/data/`.

Amadeus is not used (see Notes & limitations).

## How it fits together

```
Browser at http://localhost:3000/ (TravelMate.html from the project root, served by this server)
   │  fetch('http://localhost:3000/api/flights/search?origin=BLR&destination=DFW&departureDate=2026-11-23&...')
   ▼
Express server (server.js)
   │
   ▼
src/routes/flights.routes.js        — validates query params, checks cache
   │
   ▼
src/services/serpapi.service.js     — GET https://serpapi.com/search?engine=google_flights&...
   │
   ▼
src/utils/transformSerpApiFlights.js — flattens best_flights[] / other_flights[] into
                                        { airline, flightNumber, departureTime,
                                          arrivalTime, duration, stops, price, ... }
   │
   ▼
Response: { results: [...], meta: { ..., source: 'live', retrievedAt, cached, priceInsights, googleFlightsUrl } }
```

Every flight shown comes from SerpApi. If `SERPAPI_KEY` isn't set the route
answers 503 (`reason: "not_configured"`); if the SerpApi call fails (bad key,
rate limit, outage, unsupported airport) it answers 502
(`reason: "provider_error"`). Both carry `results: []` and
`meta.source: "unavailable"` — no generated stand-in flights. A live answer with
no flights is a 200 with an empty list.

The search is sent as a visitor from India (`gl=in`), in INR, with the
passenger counts and cabin from the form. Prices are Google Flights' totals
for all passengers. Set `SERPAPI_DEEP_SEARCH=true` to use SerpApi's slower deep
search, documented as closer to the browser's Google Flights results.

### Booking options (Book Now)

`GET /api/flights/booking-options` lists who sells one itinerary and at what
price, as Google Flights' booking page does (e.g. Qatar Airways ₹29,134 next to
MakeMyTrip ₹27,005). Send the search parameters plus `token` (the result's
`bookingToken`), or `flights` (+ `departureTime`) to find the itinerary in the
cached search. Each call costs one SerpApi search, so the page only makes it
when the rider clicks Book Now; answers are cached for 5 minutes. The card then
shows the airline's own price (`airlineOption`), and `cheapestOption` is the
lowest agent fare.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your own keys (`SERPAPI_KEY`, and
optionally `RAPIDAPI_KEY` and the `TRAIN_API_*` settings — see the comments in
`.env.example`). Never commit `.env` (it's already in `.gitignore`), and keep
keys out of the frontend: only this server reads them.

Run it:

```bash
npm start
```

Then open **http://localhost:3000/** in your browser. The server serves the
app (`TravelMate.html` from the project root) there, and the app calls the
API on the same address.

- **Don't open `TravelMate.html` as a file** (double-clicking it, `file://`):
  the browser then sends `Origin: null`, which the API refuses, so live
  searches can't work.
- The server listens on `127.0.0.1` only, so other devices on your network
  can't reach it. For a deployment, set `HOST` (e.g. `0.0.0.0`) **and**
  `ALLOWED_ORIGINS` to the site's own origin — see `.env.example`.
- The API answers only `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>`
  by default; requests from any other page get a 403 before they reach a route
  or spend an API credit. If you serve the HTML some other way (e.g. a live
  server on port 5500), add that exact origin to `ALLOWED_ORIGINS`.
- `public/index.html` is an older copy of the frontend, kept on disk for
  reference only. The server no longer serves it (`/index.html` is a 404); the
  only page it serves is `TravelMate.html`, at `/` and `/TravelMate.html`.

Travel dates must be real calendar dates, and not in the past: searches for a
date before yesterday (one day of slack for time zones) are a 400, so they
never reach SerpApi or IRCTC.

Run the tests (they start the server with every API key blanked, so they make
no SerpApi or RapidAPI calls, and set `NODE_ENV=test` with `TRAVELMATE_TODAY`
to pin "today" so their fixed dates stay valid). `TRAVELMATE_TODAY` only
applies when `NODE_ENV=test`; anywhere else it is ignored and the server warns
at startup, so it can never move the date check of a real deployment:

```bash
npm test
```

## Deploying beyond this computer

The defaults are for local use. Before other people can reach the server:

- **Network and origins** — set `HOST` (e.g. `0.0.0.0`) and set
  `ALLOWED_ORIGINS` to the site's own origin (see `.env.example`).
- **Behind a reverse proxy** (nginx, a load balancer, a hosting platform's
  router), every request reaches the server from the proxy's address. The rate
  limits (`src/middleware/rateLimit.js`) count requests per `req.ip`, so all
  users would share one allowance. Tell Express which proxy to trust by adding
  one line to `server.js`, right after `const app = express();`:

  ```js
  app.set('trust proxy', 1); // one proxy in front; or its address, e.g. 'loopback' for nginx on the same machine
  ```

  Never use `true`: Express would then believe any `X-Forwarded-For` header a
  client sends, and a client could choose its own rate-limit bucket.
- **More than one instance** — each process keeps its own rate-limit counts in
  memory, so N instances allow N times the configured limit, and the IRCTC
  request count (`TRAIN_API_USAGE_FILE`) is shared only by processes on the
  same machine. Run a single instance, divide the per-minute limits by the
  number of instances, or enforce limits at the proxy / API gateway. (A shared
  store such as Redis would need a new dependency.)
- **Per-client limits don't cap total spend**: many clients, or one client with
  many addresses, each get their own allowance (at most 10,000 clients are
  remembered per limiter, so memory stays bounded). Cap total SerpApi usage in
  your SerpApi account or at the gateway; `TRAIN_API_REQUEST_BUDGET` already
  caps total IRCTC requests.
- Leave `TRAVELMATE_TODAY` unset (outside `NODE_ENV=test` it is ignored anyway).

## API

### `GET /api/health`

Liveness check. Answers from memory without calling any external API, so it
uses no SerpApi / RapidAPI quota, and is sent with `Cache-Control: no-store`.

```json
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 42, "timestamp": "2026-10-16T08:00:00.000Z",
  "providers": {
    "flights": { "provider": "SerpApi (Google Flights)", "configured": true, "fallback": null },
    "trains":  { "provider": "Indian Railway IRCTC (RapidAPI)", "configured": true, "fallback": "erail.in timetable" },
    "buses":   { "provider": "simulated", "configured": true, "fallback": null } } }
```

`configured` only says whether a provider's key is set — the response never
contains a key or any part of one.

### `GET /api/buses/search`

**Simulated results, not live inventory.** There is no live bus API; this
generates 6–10 plausible buses (government RTCs and private operators) that
stay the same for a given route and date.

| Param  | Required | Format                       |
|--------|----------|------------------------------|
| `from` | yes      | city name                    |
| `to`   | yes      | city name, different from `from` |
| `date` | yes      | `YYYY-MM-DD` or `DD-MM-YYYY` |

```json
{ "results": [{ "id": "bus-bengaluru-chennai-6", "simulated": true, "operatorName": "KSRTC Airavat Club Class",
    "isGovt": true, "busType": "AC Multi-Axle Sleeper (2+1)", "departureTime": "02:48", "arrivalTime": "09:19",
    "duration": "6h 31m", "boardingPoints": ["Majestic", "Yeshwanthpur", "Marathahalli"],
    "droppingPoints": ["Ashok Pillar", "Tambaram", "Guindy", "Porur"],
    "fare": 1220, "fareIsEstimate": true, "rating": 3.5, "amenities": ["WiFi", "CCTV", "Reading Light", "Charging Point"],
    "checkAvailabilityUrl": "https://ksrtc.in", "checkAvailabilityLabel": "Check real buses on the KSRTC site" }],
  "meta": { "from": "Bengaluru", "to": "Chennai", "date": "2026-11-20", "count": 8,
    "source": "simulated", "notice": "Simulated schedules and fares for planning only — not live inventory. …" } }
```

There are no seat counts. `checkAvailabilityUrl` points to where real buses
on the route can be checked (the RTC's site, or a redBus route page) — it is
not a booking for the simulated bus. Missing or invalid parameters, or the
same city twice, return a 400.

### `GET /api/locations/search`

Backs the From / To autocomplete. Cities, towns and villages are the entities;
each one groups the infrastructure points that serve it.

| Param     | Required | Format | Notes                                                                    |
|-----------|----------|--------|--------------------------------------------------------------------------|
| `q`       | yes      | text   | Place name, a station / airport code, or a point name (`silk board`)     |
| `limit`   | no       | number | Default 20, max 100                                                      |
| `country` | no       | text   | Keep results to one country, e.g. `India`                                |
| `trip`    | no       | text   | `international` — only places with an airport, and only their airports   |

```json
{ "name": "Bengaluru", "title": "Bengaluru", "subtitle": "Bengaluru Urban, Karnataka",
  "type": "City", "country": "India", "domestic": true,
  "modes": ["flights", "trains", "buses"],
  "points": {
    "airports":  [{ "code": "BLR", "name": "Kempegowda International Airport" }],
    "stations":  [{ "code": "SBC", "name": "KSR Bengaluru City Junction" }, { "code": "YPR", "name": "Yesvantpur Junction" }],
    "busPoints": [{ "name": "Majestic" }, { "name": "Silk Board" }, { "name": "Marathahalli" }]
  },
  "busPointsListed": true }
```

The index (`src/services/locations.service.js`) merges `src/data/places.tsv.gz`
(~1.5 lakh Indian cities and villages), the railway station directory,
`src/data/airports.json` and `src/data/busPoints.js` (hand-listed bus points
for the big cities; every other Indian place gets points named after itself).
`GET /api/locations/stats` reports its size.

### `GET /api/locations/trip-type`

`?from=<text>&to=<text>` — decides the trip type from the two places: both in
India is `domestic` (flights, trains, buses); either one abroad is
`international` (flights only). Returns `{ tripType, modes, from, to }`, where
`from` / `to` are the matched places.

### `GET /api/flights/search`

| Param          | Required | Format       | Notes                                    |
|----------------|----------|--------------|-------------------------------------------|
| `origin`       | yes      | 3-letter IATA| e.g. `BLR`                                |
| `destination`  | yes      | 3-letter IATA| e.g. `DFW`                                |
| `departureDate`| yes      | `YYYY-MM-DD` | (`date` also accepted, as an alias)       |
| `returnDate`   | no       | `YYYY-MM-DD` | omit for one-way (SerpApi `type=2`)       |
| `cabinClass`   | no       | any string   | passed through to result `cabinClass`     |

**Success (live):**
```json
{
  "results": [
    {
      "id": "abc123",
      "airline": "Qatar Airways",
      "slug": "qatar-airways",
      "flightNumber": "QR-1234",
      "departureTime": "02:15",
      "arrivalTime": "08:40",
      "durationMinutes": 985,
      "duration": "16h 25m",
      "stops": 0,
      "stopCity": null,
      "price": 68500,
      "currency": "INR",
      "cabinClass": "ECONOMY",
      "best": true
    }
  ],
  "meta": { "origin": "BLR", "destination": "DFW", "departureDate": "2026-09-23", "returnDate": null, "count": 1, "source": "live" }
}
```

**Failure** — no flights, never generated ones: 503 `not_configured` without
`SERPAPI_KEY`, 502 `provider_error` when SerpApi fails (see above). The error
message sent to the browser is fixed text; SerpApi's own message and reply are
logged on the server only.

## ⚠️ Important: verify the SerpApi field mapping against a real response

`transformSerpApiFlights.js` was written against SerpApi's **documented**
Google Flights schema — field names like `departure_airport.time`,
`flight_number`, `total_duration`, `layovers[]`. This environment has no
outbound network access to serpapi.com, so **the mapping has not been
tested against a real live response.**

Before relying on this in production:
1. Run one real search (e.g. `curl` the endpoint or open the app and search
   BLR → DFW for 2026-09-23).
2. If cards render with missing/garbled fields, add a `console.log(JSON.stringify(serpApiResponse))`
   in `serpapi.service.js` right after the request, inspect the actual shape,
   and adjust the field lookups in `transformFlightGroup()` inside
   `transformSerpApiFlights.js` — everything downstream (routes, cache,
   frontend) stays the same.

## Notes & limitations

- **Round trips aren't fully mapped.** SerpApi bundles outbound + return legs
  into each itinerary for round-trip searches in a way this transform doesn't
  currently split apart. `returnDate` is passed through to SerpApi (sets
  `type=1`), but the resulting cards may show combined/incorrect duration.
  Stick to one-way searches until this is extended.
- **No mock flights.** `src/utils/mockFlightGenerator.js` is still in the
  repo but no route uses it; flight results only ever come from SerpApi.
- **Caching**: identical live searches are cached in-memory for 5 minutes.
  Restarting the server clears it — useful for conserving SerpApi quota
  during development.
- **Request logs** print each request's method and URL, with booking tokens
  and any key-like query values replaced by `[redacted]`.
- **Amadeus integration** (`src/services/amadeus.service.js`,
  `src/utils/transformFlightOffers.js`) is still in the repo but no longer
  called — SerpApi is now the active provider. Swap `flights.routes.js` back
  to it if you'd rather use Amadeus.
