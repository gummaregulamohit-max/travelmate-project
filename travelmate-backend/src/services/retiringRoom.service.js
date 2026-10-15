// Flags which stations have IRCTC retiring rooms, using the station codes in
// ../data/retiring-room-stations.json. That list was extracted once from the
// "IRCTC Retiring Room.pdf" table, matched against the station directory's
// codes; only the codes are kept, not the PDF's staff email/phone columns.

let cachedCodes = null;

function loadRetiringRoomCodes() {
  if (!cachedCodes) cachedCodes = new Set(require('../data/retiring-room-stations.json'));
  return cachedCodes;
}

async function hasRetiringRoom(code) {
  if (!code) return false;
  return loadRetiringRoomCodes().has(code.trim().toUpperCase());
}

module.exports = { hasRetiringRoom };
