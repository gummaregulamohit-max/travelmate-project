// Maps SerpApi's google_flights response (best_flights[] / other_flights[])
// into TravelMate's flight card shape:
//   { airline, flightNumber, departureTime, arrivalTime, duration, stops, price, ... }
//
// Hardened against exactly the crash this caused in production:
// "TypeError: Cannot read properties of undefined (reading 'flights')" —
// every property access below goes through optional chaining with a
// fallback, and both the top-level arrays and each entry inside them are
// guarded before use, so a malformed/partial SerpApi response degrades to
// an empty or partial result set instead of throwing.
//
// Written against SerpApi's documented Google Flights schema
// (https://serpapi.com/google-flights-api). If a live response still maps
// oddly, log the raw response and adjust the field lookups in
// transformFlightGroup() below — everything else downstream stays the same.

function minutesToDurationLabel(mins) {
  if (typeof mins !== 'number' || Number.isNaN(mins)) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

// SerpApi returns airport times as "YYYY-MM-DD HH:MM" (local to that airport).
function extractClockTime(dateTimeStr) {
  if (!dateTimeStr) return '';
  const parts = String(dateTimeStr).split(' ');
  return parts.length > 1 ? parts[1].slice(0, 5) : String(dateTimeStr).slice(0, 5);
}

function extractDatePart(dateTimeStr) {
  if (!dateTimeStr) return null;
  return String(dateTimeStr).split(' ')[0] || null;
}

function daysBetween(dateStrA, dateStrB) {
  if (!dateStrA || !dateStrB) return 0;
  const a = new Date(`${dateStrA}T00:00:00Z`);
  const b = new Date(`${dateStrB}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

function normalizeFlightNumber(raw) {
  if (!raw) return '';
  return String(raw).replace(/\s+/g, '-');
}

function slugifyAirline(name) {
  if (!name) return 'unknown';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * One entry in best_flights / other_flights represents a single itinerary,
 * which may have multiple `flights` segments if it connects through a layover.
 * `group` itself might be null/undefined (sparse array, malformed API
 * response) — every access below is optional-chained so that case returns
 * null instead of throwing.
 */
// "HH:MM" plus a "(+N)" marker when `dateTimeStr` falls N days after the
// journey's first departure — the same marker the itinerary's arrival uses.
function clockTimeWithDayOffset(dateTimeStr, journeyStartDate) {
  const clock = extractClockTime(dateTimeStr);
  const offset = daysBetween(journeyStartDate, extractDatePart(dateTimeStr));
  return clock && offset > 0 ? `${clock} (+${offset})` : clock;
}

function transformFlightGroup(group, index, isBest, context = {}) {
  const rawSegments = Array.isArray(group?.flights) ? group.flights.filter(Boolean) : [];
  if (rawSegments.length === 0) return null;

  // SerpApi lists segments in travel order; sorting on the local departure
  // time ("YYYY-MM-DD HH:MM" sorts as text) keeps that true even if a
  // response ever lists them out of order. Segments without a time keep
  // their place.
  const segments = rawSegments.every((s) => s?.departure_airport?.time)
    ? [...rawSegments].sort((a, b) => a.departure_airport.time.localeCompare(b.departure_airport.time))
    : rawSegments;

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  const stops = segments.length - 1;

  // For a genuine 2+ stop itinerary, list every layover city, not just the
  // first one — the old version silently dropped the second+ layover.
  let stopCity = null;
  if (stops > 0) {
    const layovers = Array.isArray(group?.layovers) ? group.layovers.filter(Boolean) : [];
    if (layovers.length) {
      stopCity = layovers
        .map((lay) => (lay?.id ? `${lay.name || lay.id} (${lay.id})` : lay?.name || null))
        .filter(Boolean)
        .join(', ');
    }
    if (!stopCity) {
      // Fall back to the arrival airport of each connecting segment (all but the last).
      stopCity = segments
        .slice(0, -1)
        .map((s) => s?.arrival_airport?.id || s?.arrival_airport?.name)
        .filter(Boolean)
        .join(', ');
    }
    if (!stopCity) stopCity = null;
  }

  const totalMinutes =
    typeof group?.total_duration === 'number'
      ? group.total_duration
      : segments.reduce((sum, s) => sum + (typeof s?.duration === 'number' ? s.duration : 0), 0);

  // Every carrier on the itinerary, in travel order ("IndiGo, KLM") — naming
  // only the first one hid the airline that flies the long-haul leg.
  const airlines = [...new Set(segments.map((s) => s?.airline).filter(Boolean))];
  const airlineName = airlines.length ? airlines.join(', ') : group?.airline || 'Unknown';

  const depDateTime = firstSegment.departure_airport?.time;
  const arrDateTime = lastSegment.arrival_airport?.time;
  const journeyStartDate = extractDatePart(depDateTime);
  const arrivalTimeLabel = clockTimeWithDayOffset(arrDateTime, journeyStartDate);

  const rawPrice = group?.price;
  const price = typeof rawPrice === 'number' ? rawPrice : (typeof rawPrice === 'string' && rawPrice.trim() !== '' ? Number(rawPrice.replace(/[^0-9.]/g, '')) : null);
  const normalizedPrice = typeof price === 'number' && !Number.isNaN(price) ? price : null;

  // Per-segment detail for the expandable itinerary view (Select → see full
  // breakdown, matching Google Flights' own expanded card). The layover
  // (if any) sits between segment i and i+1 — SerpApi's own layovers[] array
  // is index-aligned with the gaps between segments, so we look it up there
  // first and fall back to computing the gap from the two segments' times.
  const detailSegments = segments.map((seg, i) => {
    const segDep = seg?.departure_airport?.time;
    const segArr = seg?.arrival_airport?.time;
    const segMinutes = typeof seg?.duration === 'number' ? seg.duration : null;
    const layover = i < segments.length - 1 ? group?.layovers?.[i] : null;
    const nextSeg = segments[i + 1];

    let layoverMinutes = typeof layover?.duration === 'number' ? layover.duration : null;
    if (layoverMinutes === null && segArr && nextSeg?.departure_airport?.time) {
      const a = new Date(segArr.replace(' ', 'T'));
      const b = new Date(nextSeg.departure_airport.time.replace(' ', 'T'));
      if (!Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime())) {
        layoverMinutes = Math.round((b - a) / 60000);
      }
    }

    return {
      airline: seg?.airline || airlineName,
      flightNumber: normalizeFlightNumber(seg?.flight_number),
      aircraft: seg?.airplane || null,
      travelClass: (seg?.travel_class || 'Economy').toString(),
      departureAirport: seg?.departure_airport?.id || null,
      departureAirportName: seg?.departure_airport?.name || null,
      // Local clock time at each airport, with "(+N)" once the journey has
      // crossed into a later day — an overnight connection reads correctly.
      departureTime: clockTimeWithDayOffset(segDep, journeyStartDate),
      departureDate: extractDatePart(segDep),
      arrivalAirport: seg?.arrival_airport?.id || null,
      arrivalAirportName: seg?.arrival_airport?.name || null,
      arrivalTime: clockTimeWithDayOffset(segArr, journeyStartDate),
      arrivalDate: extractDatePart(segArr),
      durationMinutes: segMinutes,
      duration: segMinutes !== null ? minutesToDurationLabel(segMinutes) : null,
      legroom: seg?.legroom || null,
      extensions: Array.isArray(seg?.extensions) ? seg.extensions : [],
      layoverAfter:
        i < segments.length - 1
          ? {
              airport: layover?.id || nextSeg?.departure_airport?.id || null,
              airportName: layover?.name || nextSeg?.departure_airport?.name || null,
              durationMinutes: layoverMinutes,
              duration: layoverMinutes !== null ? minutesToDurationLabel(layoverMinutes) : null,
              // SerpApi documents this as layovers[].overnight
              overnight: !!(layover?.overnight ?? layover?.overnight_stay)
            }
          : null
    };
  });

  const carbonEmissions = group?.carbon_emissions
    ? {
        thisFlightKg: typeof group.carbon_emissions.this_flight === 'number' ? Math.round(group.carbon_emissions.this_flight / 1000) : null,
        typicalKg: typeof group.carbon_emissions.typical_for_this_route === 'number' ? Math.round(group.carbon_emissions.typical_for_this_route / 1000) : null,
        differencePercent: typeof group.carbon_emissions.difference_percent === 'number' ? group.carbon_emissions.difference_percent : null
      }
    : null;

  return {
    id: group?.booking_token || `serpapi-${isBest ? 'best' : 'other'}-${index}`,
    airline: airlineName,
    airlines,
    slug: slugifyAirline(airlines[0] || airlineName),
    flightNumber: normalizeFlightNumber(firstSegment.flight_number),
    flightNumbers: segments.map((s) => normalizeFlightNumber(s?.flight_number)).filter(Boolean),
    origin: firstSegment.departure_airport?.id || null,
    destination: lastSegment.arrival_airport?.id || null,
    departureTime: extractClockTime(depDateTime),
    arrivalTime: arrivalTimeLabel,
    durationMinutes: totalMinutes,
    duration: minutesToDurationLabel(totalMinutes),
    stops,
    stopCity,
    price: normalizedPrice,
    currency: context.currency || 'INR',
    cabinClass: (firstSegment.travel_class || 'ECONOMY').toString().toUpperCase(),
    best: !!isBest,
    departureDate: journeyStartDate,
    arrivalDate: extractDatePart(arrDateTime),
    segments: detailSegments,
    carbonEmissions,
    // Google Flights' page for this search — where this fare came from.
    bookingUrl: context.googleFlightsUrl || null,
    // Who sells this fare, and the airline's own price, take a second SerpApi
    // request with this token — made only when the rider asks (Book Now).
    bookingToken: typeof group?.booking_token === 'string' && group.booking_token ? group.booking_token : null
  };
}

const lower = (s) => String(s || '').trim().toLowerCase();

// "₹29,134" or 29134 -> 29134; anything else -> null.
function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Maps SerpApi's booking_options for one itinerary into the sellers Google
 * Flights lists ("Book with Qatar Airways  ₹29,134", "Book with MakeMyTrip
 * ₹27,005"). A seller counts as the airline when SerpApi flags it so, or when
 * its name is one of the itinerary's airlines.
 *
 * Each option: { bookWith, isAirline, price, currency, url, postData, ... }.
 * `price` is null when Google gives a booking link but no fare (Alliance Air).
 * Only one-ticket offers (`together`) are listed; separate-ticket offers are
 * counted as unsupported rather than shown with a price for half the trip.
 *
 * @param {object} serpApiJson
 * @param {string[]} itineraryAirlines e.g. ["IndiGo", "Qatar Airways"]
 * @returns {{ options: object[], airlineOption: object|null, cheapestOption: object|null,
 *             unsupportedCount: number, currency: string }}
 */
function mapBookingOptions(serpApiJson, itineraryAirlines = []) {
  const currency = serpApiJson?.search_parameters?.currency || 'INR';
  const airlineNames = new Set(itineraryAirlines.map(lower).filter(Boolean));
  const raw = Array.isArray(serpApiJson?.booking_options) ? serpApiJson.booking_options.filter(Boolean) : [];

  const options = [];
  let unsupportedCount = 0;
  for (const entry of raw) {
    const t = entry.together;
    const price = parsePrice(t?.price);
    const req = t?.booking_request || {};
    // Only Google's own click-through endpoint is passed on as a link.
    const url = typeof req.url === 'string' && /^https:\/\/www\.google\.[a-z.]+\//.test(req.url) ? req.url : null;
    // Some airlines (Alliance Air, Star Air…) come with a booking link but no
    // price. The link still opens the airline on this flight, so keep it.
    if (!t || !t.book_with || (price === null && !url)) { unsupportedCount++; continue; }
    options.push({
      bookWith: String(t.book_with),
      isAirline: t.airline === true || airlineNames.has(lower(t.book_with)),
      price,
      currency,
      optionTitle: t.option_title || null,
      flightNumbers: Array.isArray(t.marketed_as) ? t.marketed_as : [],
      // Google's click-through: POST postData to url (a form submit).
      url,
      postData: url && typeof req.post_data === 'string' ? req.post_data : null,
      phone: t.booking_phone || null
    });
  }

  // Airline first (that's the fare the rider asked to see), then cheapest.
  // Offers without a price go last within their group.
  const priceOf = (o) => (o.price === null ? Infinity : o.price);
  options.sort((a, b) => (a.isAirline === b.isAirline ? priceOf(a) - priceOf(b) : a.isAirline ? -1 : 1));
  const airlineOption = options.find((o) => o.isAirline) || null;
  const cheapestOption = options.filter((o) => o.price !== null)
    .reduce((best, o) => (!best || o.price < best.price ? o : best), null);
  return { options, airlineOption, cheapestOption, unsupportedCount, currency };
}

// The same itinerary can appear twice (once in best_flights, once in
// other_flights): same flights, same departure. Keep the cheaper copy.
function itineraryKey(f) {
  return `${f.flightNumbers.join('|')}@${f.departureDate} ${f.departureTime}`;
}

/**
 * Maps a whole SerpApi google_flights response.
 * @returns {{ results: object[], unpricedCount: number, currency: string,
 *             priceInsights: object|null, googleFlightsUrl: string|null }}
 */
function mapGoogleFlightsResponse(serpApiJson) {
  const currency = serpApiJson?.search_parameters?.currency || 'INR';
  const googleFlightsUrl = serpApiJson?.search_metadata?.google_flights_url || null;
  const context = { currency, googleFlightsUrl };

  const groups = [
    ...(Array.isArray(serpApiJson?.best_flights) ? serpApiJson.best_flights : []).map((g) => [g, true]),
    ...(Array.isArray(serpApiJson?.other_flights) ? serpApiJson.other_flights : []).map((g) => [g, false])
  ];
  const mapped = groups
    .filter(([g]) => Boolean(g))
    .map(([g, isBest], i) => transformFlightGroup(g, i, isBest, context))
    .filter(Boolean);

  // An itinerary without a price can't be compared or sorted, so it isn't
  // listed — but it is counted, so the page can say some were left out.
  const priced = mapped.filter((f) => f.price !== null);
  const byKey = new Map();
  for (const f of priced) {
    const key = itineraryKey(f);
    const seen = byKey.get(key);
    if (!seen || f.price < seen.price) byKey.set(key, seen && seen.best ? { ...f, best: true } : f);
  }

  // Google's own read on this search's prices, passed through as given.
  const pi = serpApiJson?.price_insights;
  const priceInsights = pi && typeof pi === 'object'
    ? {
        lowestPrice: typeof pi.lowest_price === 'number' ? pi.lowest_price : null,
        priceLevel: typeof pi.price_level === 'string' ? pi.price_level : null,
        typicalPriceRange: Array.isArray(pi.typical_price_range) && pi.typical_price_range.length === 2 &&
          pi.typical_price_range.every((n) => typeof n === 'number') ? pi.typical_price_range : null
      }
    : null;

  return {
    results: [...byKey.values()],
    unpricedCount: mapped.length - priced.length,
    currency,
    priceInsights,
    googleFlightsUrl
  };
}

function transformGoogleFlightsResponse(serpApiJson) {
  return mapGoogleFlightsResponse(serpApiJson).results;
}

module.exports = { transformGoogleFlightsResponse, mapGoogleFlightsResponse, mapBookingOptions };
