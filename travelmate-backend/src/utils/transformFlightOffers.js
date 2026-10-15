// Converts Amadeus's Flight Offers Search response into the flat shape
// TravelMate's frontend renders: { airline, flightNumber, departureTime,
// arrivalTime, duration, stops, price, ...extras }.
//
// Amadeus gives us multi-segment itineraries plus lookup "dictionaries" for
// carrier codes and locations — this file does the flattening + lookups.

function isoDurationToParts(iso) {
  // "PT9H35M" -> { hours: 9, minutes: 35, totalMinutes: 575 }
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  const hours = match && match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match && match[2] ? parseInt(match[2], 10) : 0;
  return { hours, minutes, totalMinutes: hours * 60 + minutes };
}

function formatClock(isoDateTime) {
  // Amadeus segment times are already local to that airport, e.g. "2026-05-01T09:35:00"
  if (!isoDateTime) return '';
  const timePart = isoDateTime.split('T')[1] || '';
  return timePart.slice(0, 5);
}

function titleCaseAirline(name) {
  if (!name) return name;
  return name.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function resolveCityName(iataCode, dictionaries) {
  // Amadeus's `dictionaries.locations` only gives 3-letter city/country codes,
  // not friendly names, so there's nothing more readable to fall back to here.
  // (TravelMate's frontend already has a full airport-name lookup it uses for
  // the origin/destination labels — plug that in client-side if you want the
  // stop city spelled out too.)
  return iataCode;
}

function transformOffer(offer, dictionaries, index) {
  const itinerary = offer.itineraries[0];
  const segments = itinerary.segments;
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  const carrierCode = firstSegment.carrierCode;
  const airlineName = (dictionaries.carriers && dictionaries.carriers[carrierCode]) || carrierCode;
  const flightNumber = `${carrierCode}-${firstSegment.number}`;

  const stops = segments.length - 1;
  const stopCity = stops > 0 ? resolveCityName(firstSegment.arrival.iataCode, dictionaries) : null;

  const { totalMinutes, hours, minutes } = isoDurationToParts(itinerary.duration);

  const fareDetails =
    offer.travelerPricings &&
    offer.travelerPricings[0] &&
    offer.travelerPricings[0].fareDetailsBySegment &&
    offer.travelerPricings[0].fareDetailsBySegment[0];

  return {
    id: offer.id || `offer-${index}`,
    airline: titleCaseAirline(airlineName),
    slug: carrierCode.toLowerCase(),
    flightNumber,
    departureTime: formatClock(firstSegment.departure.at),
    arrivalTime: formatClock(lastSegment.arrival.at),
    durationMinutes: totalMinutes,
    duration: `${hours}h ${minutes}m`,
    stops,
    stopCity,
    price: Math.round(parseFloat(offer.price.total)),
    currency: offer.price.currency,
    cabinClass: (fareDetails && fareDetails.cabin) || 'ECONOMY'
    // Note: Amadeus Self-Service doesn't reliably return baggage allowance or
    // CO2 emissions on this endpoint, so we deliberately don't fabricate them —
    // the frontend falls back to showing cabin class instead.
  };
}

function markBestFlights(flights) {
  // Mirrors the old "Best flights" vs "Other flights" split: the 2 cheapest
  // flights, preferring nonstop, are flagged best.
  const sorted = [...flights].sort((a, b) => {
    if (a.stops !== b.stops) return a.stops - b.stops;
    return a.price - b.price;
  });
  const bestIds = new Set(sorted.slice(0, Math.min(2, sorted.length)).map((f) => f.id));
  return flights.map((f) => ({ ...f, best: bestIds.has(f.id) }));
}

function transformFlightOffers(amadeusResponse) {
  const offers = (amadeusResponse && amadeusResponse.data) || [];
  const dictionaries = (amadeusResponse && amadeusResponse.dictionaries) || {};
  const transformed = offers.map((offer, i) => transformOffer(offer, dictionaries, i));
  return markBestFlights(transformed);
}

module.exports = { transformFlightOffers };
