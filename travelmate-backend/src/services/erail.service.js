// Fallback train schedule source: erail.in's public "trains between stations"
// listing — the same Indian Railways timetable IRCTC shows, including fares
// from the published fare chart (not live seat-by-seat quotes). Used by
// /api/trains/search when the RapidAPI IRCTC1 call fails or its monthly quota
// is exhausted, so the rider still sees the real trains on a route instead
// of "no trains". No API key needed.
//
// The response is one string: records separated by "^", fields by "~". The
// first record is a header (station names); each following record is a
// train. Field positions used below:
//   0 train no · 1 name · 7 boarding stn code · 9 alighting stn code
//   10 dep "HH.MM" · 12 duration "HH.MM" · 13 running days (Sun..Sat bits,
//   at the boarding station) · 21 class flags · after "DATASOURCE_IR":
//   validity start / end dates · a "<TYPE>:<km>:<fare groups>" fare chart.

const axios = require('axios');
const { deriveTrainType } = require('./irctc.service');

const ERAIL_URL = 'https://erail.in/rail/getTrains.aspx';
const REQUEST_TIMEOUT_MS = 12000;

// Class-flag / fare-group positions (e.g. a Vande Bharat flags 3 = CC and
// 10 = EC). Positions not listed never line up with a bookable class here.
const CLASS_SLOTS = { 0: '1A', 1: '2A', 2: '3A', 3: 'CC', 5: 'SL', 7: '3E', 10: 'EC' };

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeDays(bits) {
  if (!/^[01]{7}$/.test(bits) || /^1+$/.test(bits)) return 'Runs Daily';
  return `Runs on ${[...bits].map((b, i) => (b === '1' ? DAY_LABELS[i] : null)).filter(Boolean).join(', ')}`;
}

// "13.50" -> minutes after midnight
function clockMinutes(raw) {
  const m = /^(\d{1,2})\.(\d{2})$/.exec(raw || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function hhmm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function parseTrain(record, date, stationLabel) {
  const f = record.split('~');
  const trainNumber = (f[0] || '').trim();
  const dep = clockMinutes(f[10]);
  const dur = clockMinutes(f[12]);
  if (!trainNumber || dep == null || dur == null) return null;

  // Only trains that actually run from the boarding station on this weekday,
  // within their timetable validity (seasonal specials expire).
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (f[13] && f[13][weekday] !== '1') return null;
  const dsIdx = f.indexOf('DATASOURCE_IR');
  if (dsIdx !== -1) {
    const [validFrom, validTo] = [f[dsIdx + 1], f[dsIdx + 2]];
    if (/^\d{4}-\d{2}-\d{2}$/.test(validFrom) && date < validFrom) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(validTo) && date > validTo) return null;
  }

  const fareField = f.find((v) => /^[A-Z_ ]*:\d+:/.test(v));
  const fareGroups = fareField ? fareField.split(':').slice(2) : [];
  const flags = f[21] || '';
  const classes = Object.entries(CLASS_SLOTS)
    .filter(([i]) => flags[i] === '1')
    .map(([i, cls]) => {
      const fare = parseInt((fareGroups[i] || '').split(',')[0], 10);
      return fare > 0 ? { cls, fare, status: 'Check availability', tier: 'available' } : null;
    })
    .filter(Boolean);
  if (!classes.length) return null; // unreserved / parcel trains

  const arrMins = dep + dur;
  const extraDays = Math.floor(arrMins / 1440);
  const arrival = hhmm(arrMins % 1440);

  return {
    trainNumber,
    trainName: (f[1] || '').trim(),
    trainType: deriveTrainType(f[1]),
    fromStation: stationLabel(f[7]),
    toStation: stationLabel(f[9]),
    departureTime: hhmm(dep),
    arrivalTime: extraDays > 0 ? `${arrival} (+${extraDays})` : arrival,
    durationMinutes: dur,
    duration: `${Math.floor(dur / 60)}h ${String(dur % 60).padStart(2, '0')}m`,
    days: describeDays(f[13]),
    classes
  };
}

/**
 * Trains running fromCode -> toCode on `date` (YYYY-MM-DD), departure order.
 * erail already groups a city's terminals (an SBC search includes SMVB / YPR
 * departures), so no separate metro-cluster fan-out is needed.
 */
async function fetchErailTrains(fromCode, toCode, date, stationLabel) {
  const response = await axios.get(ERAIL_URL, {
    params: { Station_From: fromCode, Station_To: toCode, DataSource: 0, Language: 0, Cache: true },
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: REQUEST_TIMEOUT_MS,
    responseType: 'text'
  });
  const body = String(response.data || '');
  if (!body.includes('^')) return [];

  return body.split('^').slice(1)
    .map((record) => parseTrain(record, date, stationLabel))
    .filter(Boolean)
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

// "14.45" -> "14:45"; "First" / "Last" / blank -> null
function stopTime(raw) {
  const m = clockMinutes(raw);
  return m == null ? null : hhmm(m);
}

/**
 * Every stop of one train, in order — the same list IRCTC's "Train Schedule"
 * pop-up shows. Two calls: the train-number lookup gives erail's internal
 * train id (the field just before the source/validity block), then the route
 * call gives the stops: SN~code~name~arr~dep~halt~km~day~...
 * Returns null when the train number isn't known.
 */
async function fetchTrainSchedule(trainNumber) {
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: REQUEST_TIMEOUT_MS, responseType: 'text' };
  const lookup = await axios.get(ERAIL_URL, { ...opts, params: { TrainNo: trainNumber, DataSource: 0, Language: 0, Cache: true } });
  const record = String(lookup.data || '').split('^').slice(1).find((r) => r.split('~')[0] === trainNumber);
  if (!record) return null;
  const f = record.split('~');
  const dsIdx = f.indexOf('DATASOURCE_IR');
  const trainId = dsIdx > 3 ? f[dsIdx - 3] : null;
  if (!/^\d+$/.test(trainId || '')) return null;

  const route = await axios.get('https://erail.in/data.aspx', {
    ...opts,
    params: { Action: 'TRAINROUTE', Password: '2012', Data1: trainId, Data2: 0, Cache: true }
  });
  const stops = String(route.data || '').split('^').slice(1)
    .map((r) => r.split('~'))
    .filter((s) => s[1])
    .map((s) => ({
      code: s[1],
      name: s[2],
      routeNumber: 1,
      arrival: stopTime(s[3]),
      departure: stopTime(s[4]),
      halt: /^\d+$/.test(s[5]) && s[3] !== 'First' && s[4] !== 'Last' ? parseInt(s[5], 10) : null,
      distance: /^\d+$/.test(s[6]) ? parseInt(s[6], 10) : null,
      day: parseInt(s[7], 10) || 1
    }));
  if (!stops.length) return null;

  return {
    train: {
      number: trainNumber,
      name: (f[1] || '').trim(),
      fromCode: f[3], fromName: f[2],
      toCode: f[5], toName: f[4],
      days: describeDays(f[13])
    },
    stops
  };
}

module.exports = { fetchErailTrains, fetchTrainSchedule };
