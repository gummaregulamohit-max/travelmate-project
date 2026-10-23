// GET /api/flights/booking-options — used by TravelMate's flight "Book Now".
//
// Returns Google Flights' booking options for one flight ("Book with Qatar
// Airways", "Book with MakeMyTrip", ...). Each option has a booking_request
// { url, post_data }: a POST to google.com/travel/clk that lands on the
// seller's own site with the flight, date and passengers already chosen.
// This works the same way for every airline Google Flights lists.
//
// The page asks in one of two ways:
//   ?token=<booking_token>&origin&destination&date...   (results carried the token)
//   ?flights=6E1301,QR283&departureTime=21:10&origin&destination&date...
//      (no token: the same search is run again and the flight is found by its
//       flight numbers to get its token — SerpApi serves a repeat of a recent
//       search from its cache)
//
// Setup (Express, Node 18+ for the built-in fetch):
//   const mountFlightBookingOptions = require('./flight-booking-options');
//   mountFlightBookingOptions(app);            // next to /api/flights/search
//
// Optional, saves one SerpApi call per click: in the code that maps SerpApi
// results for /api/flights/search, also pass on, for each best_flights /
// other_flights item:
//   bookingToken: item.booking_token,
//   airlineLogo:  item.airline_logo,
//   segments: item.flights.map(leg => ({ ...yourExistingLegFields, airlineLogo: leg.airline_logo })),
//
// Uses the SerpApi key in SERPAPI_API_KEY (rename to whatever your search
// code reads).

const SERPAPI_URL = 'https://serpapi.com/search.json';
const CABIN = { ECONOMY: '1', PREMIUM_ECONOMY: '2', BUSINESS: '3', FIRST: '4' };

const normNo = (n) => String(n || '').replace(/[\s-]/g, '').toUpperCase();
const hhmm = (t) => { const m = /(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };

async function serpapi(params) {
  const r = await fetch(`${SERPAPI_URL}?${params}`, { signal: AbortSignal.timeout(16000) });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || body.error) throw new Error((body && body.error) || `SerpApi answered ${r.status}.`);
  return body;
}

// The flight in the search results with these flight numbers. An exact match
// on every leg wins; otherwise the same first leg (and departure time, when
// given) is accepted.
function findToken(body, flights, departureTime) {
  const wanted = flights.map(normNo);
  const items = [...(body.best_flights || []), ...(body.other_flights || [])];
  const legsOf = (it) => (it.flights || []).map(l => normNo(l.flight_number));
  const depOf = (it) => hhmm(((it.flights || [])[0] || {}).departure_airport?.time);
  const exact = items.find(it => legsOf(it).join(',') === wanted.join(','));
  if (exact) return exact.booking_token;
  const want = hhmm(departureTime);
  const near = items.find(it => legsOf(it)[0] === wanted[0] && (!want || depOf(it) === want));
  return near ? near.booking_token : null;
}

module.exports = function mountFlightBookingOptions(app) {
  app.get('/api/flights/booking-options', async (req, res) => {
    const { token, flights, departureTime, origin, destination, date, returnDate, cabinClass, adults, children, infants } = req.query;
    if ((!token && !flights) || !origin || !destination || !date) {
      return res.status(400).json({ error: { message: 'token or flights, plus origin, destination and date, are required.' } });
    }
    if (!token && returnDate) {
      return res.status(400).json({ error: { message: 'Round trips need the booking token from the search results.' } });
    }
    const apiKey = process.env.SERPAPI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: { message: 'SERPAPI_API_KEY is not set.' } });

    // Must match the search the token came from.
    const base = new URLSearchParams({
      engine: 'google_flights',
      departure_id: String(origin).toUpperCase(),
      arrival_id: String(destination).toUpperCase(),
      outbound_date: date,
      type: returnDate ? '1' : '2', // 1 = round trip, 2 = one way
      travel_class: CABIN[String(cabinClass || 'ECONOMY').toUpperCase()] || '1',
      adults: String(adults || 1),
      children: String(children || 0),
      infants_in_seat: '0',
      infants_on_lap: String(infants || 0),
      currency: 'INR',
      hl: 'en',
      gl: 'in',
      api_key: apiKey
    });
    if (returnDate) base.set('return_date', returnDate);

    try {
      let bookingToken = token;
      if (!bookingToken) {
        const search = await serpapi(base);
        bookingToken = findToken(search, String(flights).split(',').filter(Boolean), departureTime);
        if (!bookingToken) return res.status(404).json({ error: { message: 'That flight is no longer listed for this date.' } });
      }

      const params = new URLSearchParams(base);
      params.set('booking_token', bookingToken);
      const body = await serpapi(params);

      // Each option is { together: {...} } or, for split tickets,
      // { separate_tickets: true, departing: {...}, returning: {...} }.
      const options = (body.booking_options || []).map(o => {
        const x = o.together || o.departing || {};
        const reqInfo = x.booking_request || {};
        return {
          bookWith: x.book_with || '',
          isAirline: x.airline === true,
          logos: x.airline_logos || [],
          price: x.price ?? null,
          separateTickets: !!o.separate_tickets,
          url: reqInfo.url || null,
          postData: reqInfo.post_data || null
        };
      }).filter(o => o.url);
      res.json({ options });
    } catch (err) {
      res.status(502).json({ error: { message: err.message || 'Booking options lookup failed.' } });
    }
  });
};
