// Loads the Indian Railway station directory and exposes a case-insensitive
// name/code search over it. The curated major stations come first, from
// ../data/major-stations.json (converted once from the "Major Stations" sheet
// of Indian_Railway_Station_List.xlsx, so the backend needs no files outside
// the repository).
//
// Built once and cached in memory.

let cachedStations = null;

function loadStations() {
  if (cachedStations) return cachedStations;

  cachedStations = require('../data/major-stations.json').map(({ category, name, code, city, state }) => ({
    category,
    name,
    code,
    city,
    state
  }));

  // Every other Indian Railways station (DataMeet, CC0 — github.com/datameet/railways),
  // as [code, name, city, state]; the spreadsheet's entries stay first.
  const known = new Set(cachedStations.map((st) => st.code));
  for (const [code, name, city, state] of require('../data/stations-full.json')) {
    if (!known.has(code)) cachedStations.push({ category: 'Station', name, code, city, state });
  }

  return cachedStations;
}

/**
 * Case-insensitive substring search over station name or code.
 * An empty/missing query returns the full directory.
 */
function searchStations(query) {
  const stations = loadStations();
  const q = (query || '').trim().toLowerCase();
  if (!q) return stations;
  // Exact code first, then code prefix, name prefix, anything else.
  const score = (s) => {
    const code = s.code.toLowerCase(), name = s.name.toLowerCase();
    return code === q ? 0 : code.startsWith(q) ? 1 : name.startsWith(q) ? 2 : 3;
  };
  return stations
    .filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
    .sort((a, b) => score(a) - score(b));
}

function findStationByCode(code) {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return loadStations().find((s) => s.code === upper) || null;
}

module.exports = { loadStations, searchStations, findStationByCode };
