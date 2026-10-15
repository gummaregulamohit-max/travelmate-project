// Rough flag-carrier + notable-carrier mapping per country, used only to make
// generated mock flights *look* plausible (e.g. don't put Qantas on a
// Bengaluru–Amsterdam route). Not exhaustive — unmapped countries fall back
// to the GLOBAL_HUB_CARRIERS pool in mockFlightGenerator.js.

const COUNTRY_CARRIERS = {
  India: [{ name: 'IndiGo', slug: 'indigo', longHaul: false }, { name: 'Air India', slug: 'air-india', longHaul: true }, { name: 'Akasa Air', slug: 'akasa', longHaul: false }, { name: 'SpiceJet', slug: 'spicejet', longHaul: false }],
  'United Arab Emirates': [{ name: 'Emirates', slug: 'emirates', longHaul: true }, { name: 'Etihad Airways', slug: 'etihad', longHaul: true }, { name: 'Air Arabia', slug: 'air-arabia', longHaul: false }],
  Qatar: [{ name: 'Qatar Airways', slug: 'qatar', longHaul: true }],
  'United States': [{ name: 'United Airlines', slug: 'united', longHaul: true }, { name: 'Delta Air Lines', slug: 'delta', longHaul: true }, { name: 'American Airlines', slug: 'american', longHaul: true }],
  'United Kingdom': [{ name: 'British Airways', slug: 'british-airways', longHaul: true }, { name: 'Virgin Atlantic', slug: 'virgin-atlantic', longHaul: true }],
  Germany: [{ name: 'Lufthansa', slug: 'lufthansa', longHaul: true }],
  France: [{ name: 'Air France', slug: 'air-france', longHaul: true }],
  Netherlands: [{ name: 'KLM', slug: 'klm', longHaul: true }],
  Singapore: [{ name: 'Singapore Airlines', slug: 'singapore-airlines', longHaul: true }],
  Australia: [{ name: 'Qantas', slug: 'qantas', longHaul: true }],
  Japan: [{ name: 'ANA', slug: 'ana', longHaul: true }, { name: 'Japan Airlines', slug: 'jal', longHaul: true }],
  China: [{ name: 'China Southern', slug: 'china-southern', longHaul: true }, { name: 'China Eastern', slug: 'china-eastern', longHaul: true }],
  Turkey: [{ name: 'Turkish Airlines', slug: 'turkish-airlines', longHaul: true }],
  Thailand: [{ name: 'Thai Airways', slug: 'thai-airways', longHaul: true }],
  'South Korea': [{ name: 'Korean Air', slug: 'korean-air', longHaul: true }],
  Canada: [{ name: 'Air Canada', slug: 'air-canada', longHaul: true }],
  'Saudi Arabia': [{ name: 'Saudia', slug: 'saudia', longHaul: true }],
  Malaysia: [{ name: 'Malaysia Airlines', slug: 'malaysia-airlines', longHaul: true }],
  Indonesia: [{ name: 'Garuda Indonesia', slug: 'garuda-indonesia', longHaul: true }],
  Switzerland: [{ name: 'Swiss International', slug: 'swiss', longHaul: true }],
  Italy: [{ name: 'ITA Airways', slug: 'ita-airways', longHaul: true }],
  Spain: [{ name: 'Iberia', slug: 'iberia', longHaul: true }],
  'South Africa': [{ name: 'South African Airways', slug: 'south-african-airways', longHaul: true }],
  Egypt: [{ name: 'EgyptAir', slug: 'egyptair', longHaul: true }],
  Kenya: [{ name: 'Kenya Airways', slug: 'kenya-airways', longHaul: true }],
  'New Zealand': [{ name: 'Air New Zealand', slug: 'air-nz', longHaul: true }],
  Brazil: [{ name: 'LATAM Airlines', slug: 'latam', longHaul: true }],
  Oman: [{ name: 'Oman Air', slug: 'oman-air', longHaul: true }],
  Bahrain: [{ name: 'Gulf Air', slug: 'gulf-air', longHaul: true }],
  Kuwait: [{ name: 'Kuwait Airways', slug: 'kuwait-airways', longHaul: true }]
};

// Global long-haul carriers that plausibly serve almost any intercontinental
// city pair via their hub — used to fill out routes where neither country
// has a mapped flag carrier, or to add a connecting-flight option. All are
// long-haul by definition (no `longHaul: false` filtering needed on these).
const GLOBAL_HUB_CARRIERS = [
  { name: 'Emirates', slug: 'emirates', hub: 'Dubai (DXB)', longHaul: true },
  { name: 'Qatar Airways', slug: 'qatar', hub: 'Doha (DOH)', longHaul: true },
  { name: 'Turkish Airlines', slug: 'turkish-airlines', hub: 'Istanbul (IST)', longHaul: true },
  { name: 'Singapore Airlines', slug: 'singapore-airlines', hub: 'Singapore (SIN)', longHaul: true },
  { name: 'Etihad Airways', slug: 'etihad', hub: 'Abu Dhabi (AUH)', longHaul: true }
];

module.exports = { COUNTRY_CARRIERS, GLOBAL_HUB_CARRIERS };
