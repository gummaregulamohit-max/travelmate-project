// Bus boarding / dropping points per city — the one list both the location
// directory (locations.service) and the bus generator (mockBusGenerator) use,
// so a point suggested in the From / To dropdown is a point buses stop at.
//
// Keyed by lower-case city name. Any place not listed here gets a generic set
// built from its own name (see busPointsFor), so every city and village has
// bus points.

const CITY_BUS_POINTS = {
  bengaluru: ['Majestic', 'Anand Rao Circle', 'Kalasipalyam', 'Madiwala', 'Silk Board', 'Jayanagar', 'Electronic City', 'Hebbal', 'Yeshwanthpur', 'Marathahalli', 'KR Puram', 'Shanthinagar'],
  hyderabad: ['Miyapur', 'KPHB Colony', 'Ameerpet', 'Lakdikapul', 'MGBS', 'Kacheguda', 'Dilsukhnagar', 'LB Nagar', 'Aramghar', 'Shamshabad', 'Gachibowli'],
  chennai: ['Koyambedu (CMBT)', 'Kilambakkam (KCBT)', 'Guindy', 'Ashok Pillar', 'Vadapalani', 'Porur', 'Tambaram', 'Perungalathur', 'Maduravoyal'],
  mumbai: ['Dadar', 'Sion', 'Chembur', 'Borivali', 'Andheri', 'Thane', 'Vashi', 'Panvel', 'Kurla'],
  pune: ['Swargate', 'Shivajinagar', 'Wakad', 'Hinjewadi', 'Katraj', 'Hadapsar', 'Nigdi', 'Chandni Chowk'],
  delhi: ['Kashmere Gate ISBT', 'Anand Vihar ISBT', 'Majnu Ka Tilla', 'Dhaula Kuan', 'Sarai Kale Khan', 'Mahipalpur'],
  vijayawada: ['Pandit Nehru Bus Station', 'Benz Circle', 'Ramavarappadu Ring', 'Gollapudi', 'Kanaka Durga Varadhi'],
  goa: ['Panaji Kadamba', 'Mapusa', 'Margao', 'Porvorim', 'Vasco'],
  kochi: ['Vyttila Hub', 'Edappally', 'Kaloor', 'Palarivattom', 'Aluva'],
  coimbatore: ['Gandhipuram', 'Ukkadam', 'Singanallur', 'Avinashi Road', 'Hope College'],
  mysuru: ['Mysuru Suburban Bus Stand', 'Hunsur Road', 'Bannimantap', 'Infosys Gate'],
  tirupati: ['Tirupati Bus Station', 'Alipiri', 'Leela Mahal Circle', 'Renigunta'],
  visakhapatnam: ['Dwaraka Bus Station', 'Maddilapalem', 'NAD Junction', 'Gajuwaka', 'Madhurawada'],
  kolkata: ['Esplanade', 'Howrah', 'Karunamoyee', 'Ultadanga', 'Airport Gate 1'],
  ahmedabad: ['Paldi', 'Geeta Mandir', 'Nehrunagar', 'Iscon Cross Road', 'Naroda'],
  jaipur: ['Sindhi Camp', 'Narayan Singh Circle', 'Durgapura', 'Ajmer Road', '200 Feet Bypass'],
  mangalore: ['Bejai KSRTC', 'Pumpwell', 'Kankanady', 'Nanthoor', 'Surathkal'],
  nellore: ['Nellore RTC Bus Stand', 'Atmakur Bus Stand', 'Mini Bypass'],
  kurnool: ['Kurnool Bus Stand', 'Kurnool Toll Plaza', 'Kotla Circle'],
  kadapa: ['Kadapa RTC Bus Stand', 'Kadapa Bypass', 'Ravindra Nagar'],
  surat: ['Udhna', 'Ring Road', 'Varachha', 'Adajan', 'Katargam', 'Piplod'],
  vadodara: ['Panigate', 'Karelibaug', 'Gorwa', 'Alkapuri', 'Manjalpur', 'Sayajigunj'],
  lucknow: ['Alambagh', 'Charbagh', 'Kaiserbagh', 'Gomti Nagar', 'Indira Nagar', 'Aminabad'],
  chandigarh: ['ISBT Sector 43', 'ISBT Sector 17', 'Sector 22', 'Manimajra', 'Panchkula'],
  indore: ['Sarwate Bus Stand', 'Gangwal Bus Stand', 'Vijay Nagar', 'Rajwada', 'Bhawarkuan', 'Palasia'],
  nagpur: ['Ganeshpeth', 'MIDC', 'Wardha Road', 'Sitabuldi', 'Kamptee Road', 'Hingna'],
  dehradun: ['ISBT Dehradun', 'Clock Tower', 'Rajpur Road', 'Prem Nagar'],
  guwahati: ['ISBT Guwahati', 'Paltan Bazar', 'Khanapara', 'Adabari'],
  bhubaneswar: ['Baramunda Bus Stand', 'Rasulgarh', 'Patia', 'Jaydev Vihar'],
  madurai: ['Mattuthavani', 'Arapalayam', 'Periyar Bus Stand', 'Villapuram'],
  shimla: ['ISBT Tutikandi', 'Cart Road', 'Sanjauli', 'Vikasnagar'],
  manali: ['Manali Bus Stand', 'Vashisht', 'Old Manali'],
  udaipur: ['Udaipur Bus Stand', 'Chetak Circle', 'Sukher', 'Bhuwana']
};

// Other spellings of the cities above.
const CITY_ALIASES = { bangalore: 'bengaluru', mysore: 'mysuru', panaji: 'goa', mangaluru: 'mangalore', vizag: 'visakhapatnam', cochin: 'kochi' };

function cityKey(name) {
  const key = (name || '').replace(/\s*\(.*\)\s*/, '').trim().toLowerCase();
  return CITY_ALIASES[key] || key;
}

/** The hand-listed points of a city, or null when it has none. */
function knownBusPoints(name) {
  return CITY_BUS_POINTS[cityKey(name)] || null;
}

/**
 * Bus points of any place: the hand-listed ones for a known city, otherwise a
 * generic set named after the place — a bus stand and bypass for a city or
 * town, a bus stop and village centre for a village.
 */
function busPointsFor(name, type) {
  const known = knownBusPoints(name);
  if (known) return known;
  const label = (name || 'City').replace(/\s*\(.*\)\s*/, '').trim();
  if (type === 'Village') return [`${label} Bus Stop`, `${label} Main Road`, `${label} Village Centre`];
  return [`${label} Bus Stand`, `${label} Bypass`, `${label} Main Road`];
}

module.exports = { CITY_BUS_POINTS, knownBusPoints, busPointsFor };
