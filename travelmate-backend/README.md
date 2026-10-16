# TravelMate Backend

Active providers:

- **Flights** — real flight data via [SerpApi's Google Flights engine](https://serpapi.com/google-flights-api),
  with a dynamic mock generator as a fallback when the API is unavailable.
- **Trains** — the Indian Railway IRCTC API on RapidAPI verifies timetable
  trains, with the public erail.in timetable as fallback. Fares are fare-chart
  prices; live seat availability is not offered.
- **Buses** — simulated only (no live bus API); see `GET /api/buses/search`.
- **Locations and stations** — bundled data in `src/data/`.

Amadeus is not used (see Notes & limitations).

## How it fits together

```
Browser (public/index.html, your TravelMate frontend)
   │  fetch('/api/flights/search?origin=BLR&destination=DFW&departureDate=2026-09-23&...')
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
Response: { results: [...], meta: { ..., source: 'live' | 'mock' } }
```

If `SERPAPI_KEY` isn't set, or the SerpApi call fails for any reason (bad key,
rate limit, outage, unsupported airport), the route falls back to
`src/utils/mockFlightGenerator.js`, which generates 4–6 realistic flights for
*any* origin/destination pair. `meta.source` tells you which happened. The
frontend uses this to show a "showing demo data" note when it's not live.

## Setup

```bash
npm install
```

`.env` is already filled in with the SerpApi key you provided. **That key
was pasted in plaintext in a chat conversation — treat it as potentially
exposed and consider rotating it at https://serpapi.com/manage-api-key once
you've confirmed everything works.** Never commit `.env` (it's already in
`.gitignore`); `.env.example` has a placeholder instead.

Run it:

```bash
npm start
```

Open http://localhost:3000 — your TravelMate frontend, served by this same
server, wired up to live Google Flights search.

Run the tests (they start the server with every API key blanked, so they make
no SerpApi or RapidAPI calls):

```bash
npm test
```

## API

### `GET /api/health`

Liveness check. Answers from memory without calling any external API, so it
uses no SerpApi / RapidAPI quota, and is sent with `Cache-Control: no-store`.

```json
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 42, "timestamp": "2026-10-16T08:00:00.000Z",
  "providers": {
    "flights": { "provider": "SerpApi (Google Flights)", "configured": true, "fallback": "mock" },
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

**Failure** — falls back to mock data (see above) rather than erroring the
whole search, unless the fallback itself is impossible (it never is, since
the mock generator handles any IATA pair).

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
- **Any origin/destination works** even without SerpApi, via
  `mockFlightGenerator.js` (see the previous iteration's notes below) —
  classifies routes by country/continent using `src/data/airports.json` and
  picks realistic airlines from `src/data/carriers.js`, filtered so
  budget/short-haul carriers never appear on intercontinental routes.
- **Caching**: identical searches (live or mock) are cached in-memory for 5
  minutes. Restarting the server clears it — useful for conserving SerpApi
  quota during development.
- **Amadeus integration** (`src/services/amadeus.service.js`,
  `src/utils/transformFlightOffers.js`) is still in the repo but no longer
  called — SerpApi is now the active provider. Swap `flights.routes.js` back
  to it if you'd rather use Amadeus.
