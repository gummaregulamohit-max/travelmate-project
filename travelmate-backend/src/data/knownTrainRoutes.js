// A static reference timetable for a handful of well-known routes, checked by
// hand against the public timetable (train numbers, names, and departure/
// arrival times match the actual services; fares are illustrative estimates,
// not live IRCTC pricing). Used by /api/trains/search only as a last resort,
// when the erail.in timetable can't be reached; such results are labelled
// source 'reference' and are never live or IRCTC-verified. The class statuses
// below are hand-entered and are never shown as seat availability (see
// utils/seatAvailability.js). Routes not listed here get no trains — nothing
// is generated.
//
// IMPORTANT: keyed by STATION CODE pairs ("FROMCODE->TOCODE"), not city names.
// Two different stations in the same city (e.g. SBC and YPR are both "Bengaluru")
// are genuinely different origins/destinations on IRCTC, so the lookup key has to
// reflect the exact station the passenger picked, not the city it happens to sit in.
const KNOWN_TRAIN_ROUTES = {
  'NDLS->MMCT': [
    { trainNumber: '12952', trainName: 'Mumbai Central Rajdhani Express', departureTime: '16:55', arrivalTime: '08:35 (+1)', duration: '15h 40m', days: 'Runs Daily',
      classes: [
        { cls: '1A', fare: 5195, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 3080, status: 'Available', tier: 'available' },
        { cls: '3A', fare: 2190, status: 'RAC 8', tier: 'rac' }
      ] }
  ],
  'NZM->MMCT': [
    { trainNumber: '12954', trainName: 'August Kranti Rajdhani Express', departureTime: '17:15', arrivalTime: '10:05 (+1)', duration: '16h 50m', days: 'Runs Daily',
      classes: [
        { cls: '1A', fare: 5350, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 3145, status: 'WL 3', tier: 'wl' },
        { cls: '3A', fare: 2230, status: 'Available', tier: 'available' }
      ] }
  ],
  'MMCT->NDLS': [
    { trainNumber: '12951', trainName: 'Mumbai Rajdhani Express', departureTime: '17:00', arrivalTime: '08:35 (+1)', duration: '15h 35m', days: 'Runs Daily',
      classes: [
        { cls: '1A', fare: 5195, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 3080, status: 'RAC 6', tier: 'rac' },
        { cls: '3A', fare: 2190, status: 'Available', tier: 'available' }
      ] }
  ],
  'MMCT->NZM': [
    { trainNumber: '12953', trainName: 'August Kranti Rajdhani Express', departureTime: '17:10', arrivalTime: '09:43 (+1)', duration: '16h 33m', days: 'Runs Daily',
      classes: [
        { cls: '1A', fare: 5350, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 3145, status: 'Available', tier: 'available' },
        { cls: '3A', fare: 2230, status: 'WL 5', tier: 'wl' }
      ] }
  ],
  'SBC->MAS': [
    { trainNumber: '12028', trainName: 'Chennai Central Shatabdi Express', departureTime: '06:00', arrivalTime: '11:00', duration: '5h 00m', days: 'Runs 6 days a week (except Tue)',
      classes: [
        { cls: 'CC', fare: 875, status: 'Available', tier: 'available' },
        { cls: 'EC', fare: 1640, status: 'Available', tier: 'available' }
      ] }
  ],
  'MAS->SBC': [
    { trainNumber: '12027', trainName: 'KSR Bengaluru Shatabdi Express', departureTime: '17:30', arrivalTime: '22:25', duration: '4h 55m', days: 'Runs 6 days a week (except Tue)',
      classes: [
        { cls: 'CC', fare: 875, status: 'Available', tier: 'available' },
        { cls: 'EC', fare: 1640, status: 'RAC 4', tier: 'rac' }
      ] }
  ],
  'SBC->NZM': [
    { trainNumber: '22691', trainName: 'KSR Bengaluru - Hazrat Nizamuddin Rajdhani Express', departureTime: '20:00', arrivalTime: '05:30 (+2)', duration: '33h 30m', days: 'Runs Daily',
      classes: [
        { cls: '1A', fare: 6480, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 3820, status: 'WL 2', tier: 'wl' },
        { cls: '3A', fare: 2705, status: 'Available', tier: 'available' }
      ] }
  ],
  'NZM->SBC': [
    { trainNumber: '22692', trainName: 'Hazrat Nizamuddin - KSR Bengaluru Rajdhani Express', departureTime: '20:50', arrivalTime: '06:35 (+2)', duration: '33h 45m', days: 'Runs Daily',
      classes: [
        { cls: '1A', fare: 6480, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 3820, status: 'Available', tier: 'available' },
        { cls: '3A', fare: 2705, status: 'RAC 10', tier: 'rac' }
      ] }
  ],
  'SBC->KCG': [
    { trainNumber: '12786', trainName: 'Kacheguda Express', departureTime: '18:00', arrivalTime: '05:40 (+1)', duration: '11h 40m', days: 'Runs Daily',
      classes: [
        { cls: 'SL', fare: 395, status: 'Available', tier: 'available' },
        { cls: 'CC', fare: 780, status: 'Available', tier: 'available' },
        { cls: '3A', fare: 1035, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 1490, status: 'RAC 4', tier: 'rac' },
        { cls: '1A', fare: 2490, status: 'Available', tier: 'available' }
      ] }
  ],
  'KCG->SBC': [
    { trainNumber: '12785', trainName: 'Kacheguda Express', departureTime: '19:05', arrivalTime: '06:10 (+1)', duration: '11h 05m', days: 'Runs Daily',
      classes: [
        { cls: 'SL', fare: 395, status: 'Available', tier: 'available' },
        { cls: 'CC', fare: 780, status: 'RAC 2', tier: 'rac' },
        { cls: '3A', fare: 1035, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 1490, status: 'Available', tier: 'available' },
        { cls: '1A', fare: 2490, status: 'WL 1', tier: 'wl' }
      ] }
  ],
  // Kacheguda (KCG) <-> Yesvantpur (YPR): the 20703/20704 Mini Vande Bharat,
  // one of several real Bengaluru<->Hyderabad services split across each
  // city's multiple terminals (SBC/YPR/SMVB and KCG/SC/HYB) — see the
  // BENGALURU/HYDERABAD clusters in trains.routes.js. Times per public
  // timetable: 20703 departs Kacheguda 05:45, arrives Yesvantpur 14:00;
  // 20704 departs Yesvantpur 14:45, arrives Kacheguda 23:00. Runs 6 days
  // (not Wednesday).
  'KCG->YPR': [
    { trainNumber: '20703', trainName: 'Kacheguda - Yesvantpur Vande Bharat Express', departureTime: '05:45', arrivalTime: '14:00', duration: '8h 15m', days: 'Runs 6 days a week (except Wed)',
      classes: [
        { cls: 'CC', fare: 1385, status: 'Available', tier: 'available' },
        { cls: 'EC', fare: 2555, status: 'Available', tier: 'available' }
      ] }
  ],
  'YPR->KCG': [
    { trainNumber: '20704', trainName: 'Yesvantpur - Kacheguda Vande Bharat Express', departureTime: '14:45', arrivalTime: '23:00', duration: '8h 15m', days: 'Runs 6 days a week (except Wed)',
      classes: [
        { cls: 'CC', fare: 1385, status: 'Available', tier: 'available' },
        { cls: 'EC', fare: 2555, status: 'Available', tier: 'available' }
      ] }
  ],
  // Bengaluru -> Markapur Road (MRK), checked against IRCTC's train list for
  // 29 Oct 2026: 18464 Prashanthi Express from KSR Bengaluru (daily) and 17212
  // Kondaveedu Express from Yesvantpur (Tue, Thu, Sat). Timings and days are
  // IRCTC's; fares are approximate (IRCTC only quotes them per class on request).
  'SBC->MRK': [
    { trainNumber: '18464', trainName: 'Prashanthi Express', departureTime: '13:40', arrivalTime: '01:09 (+1)', duration: '11h 29m', days: 'Runs Daily',
      classes: [
        { cls: 'SL', fare: 375, status: 'Available', tier: 'available' },
        { cls: '3A', fare: 1010, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 1435, status: 'Available', tier: 'available' },
        { cls: '1A', fare: 2420, status: 'Available', tier: 'available' }
      ] }
  ],
  'YPR->MRK': [
    { trainNumber: '17212', trainName: 'Kondaveedu Express', departureTime: '12:45', arrivalTime: '22:44', duration: '9h 59m', days: 'Runs Tue, Thu, Sat',
      classes: [
        { cls: 'SL', fare: 360, status: 'Available', tier: 'available' },
        { cls: '3A', fare: 975, status: 'Available', tier: 'available' },
        { cls: '2A', fare: 1390, status: 'Available', tier: 'available' },
        { cls: '1A', fare: 2330, status: 'Available', tier: 'available' }
      ] }
  ]
};

function findKnownTrains(from, to) {
  return KNOWN_TRAIN_ROUTES[`${from}->${to}`] || null;
}

module.exports = { findKnownTrains };
