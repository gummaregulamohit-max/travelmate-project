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
function transformFlightGroup(group, index, isBest) {
  const segments = group?.flights;
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  if (!firstSegment || !lastSegment) return null;

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

  const airlineName = firstSegment.airline || group?.airline || 'Unknown';

  const depDateTime = firstSegment.departure_airport?.time;
  const arrDateTime = lastSegment.arrival_airport?.time;
  const extraDays = daysBetween(extractDatePart(depDateTime), extractDatePart(arrDateTime));
  const arrivalTimeLabel = extractClockTime(arrDateTime) + (extraDays > 0 ? ` (+${extraDays})` : '');

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
      departureTime: extractClockTime(segDep),
      arrivalAirport: seg?.arrival_airport?.id || null,
      arrivalAirportName: seg?.arrival_airport?.name || null,
      arrivalTime: extractClockTime(segArr),
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
              overnight: !!layover?.overnight_stay
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
    slug: slugifyAirline(airlineName),
    flightNumber: normalizeFlightNumber(firstSegment.flight_number),
    departureTime: extractClockTime(depDateTime),
    arrivalTime: arrivalTimeLabel,
    durationMinutes: totalMinutes,
    duration: minutesToDurationLabel(totalMinutes),
    stops,
    stopCity,
    price: normalizedPrice,
    currency: 'INR',
    cabinClass: (firstSegment.travel_class || 'ECONOMY').toString().toUpperCase(),
    best: !!isBest,
    departureDate: extractDatePart(depDateTime),
    segments: detailSegments,
    carbonEmissions
  };
}

function transformGoogleFlightsResponse(serpApiJson) {
  const bestGroups = Array.isArray(serpApiJson?.best_flights) ? serpApiJson.best_flights : [];
  const otherGroups = Array.isArray(serpApiJson?.other_flights) ? serpApiJson.other_flights : [];

  const best = bestGroups
    .filter(Boolean)
    .map((g, i) => transformFlightGroup(g, i, true))
    .filter(Boolean);
  const other = otherGroups
    .filter(Boolean)
    .map((g, i) => transformFlightGroup(g, i, false))
    .filter(Boolean);

  // Drop any entry SerpApi didn't give us a price for — a card with no
  // price isn't useful and shouldn't silently render as "null".
  return [...best, ...other].filter((f) => f.price !== null);
}

module.exports = { transformGoogleFlightsResponse };
