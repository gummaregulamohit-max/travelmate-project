// The key that lets TravelMate.html opened as a file (file://) use the API.
//
// Such a page sends "Origin: null" — and so do sandboxed frames on any
// website, so null alone proves nothing. At startup the server writes a random
// key into travelmate-local-key.js next to TravelMate.html; the page, opened
// from disk, loads that file and sends the key with every API call. A website
// can't read this computer's disk, so it can't learn the key. The key is kept
// across restarts (a page opened before `npm start` still works once the
// server is up) and is never served over http.

const crypto = require('crypto');
const fs = require('fs');

const KEY_PATTERN = /window\.TM_LOCAL_KEY = '([0-9a-f]{64})';/;

let localKey = null;

function keyFileSource(key) {
  return [
    '// Written by the TravelMate backend (npm start). It lets TravelMate.html,',
    '// opened as a file, use the API at http://localhost:3000. Keep it private:',
    '// don\'t commit or share it. Delete it to get a new key on the next start.',
    `window.TM_LOCAL_KEY = '${key}';`,
    ''
  ].join('\n');
}

/**
 * The key in `file`, created there first if the file is missing or holds no
 * valid key. Returns null (file pages are then refused) if it can't be written.
 */
function ensureLocalKey(file) {
  let key = null;
  try {
    const match = KEY_PATTERN.exec(fs.readFileSync(file, 'utf8'));
    if (match) key = match[1];
  } catch { /* missing or unreadable — written below */ }
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, keyFileSource(key), { mode: 0o600 });
    } catch (err) {
      console.warn(`⚠️  Could not write ${file} (${err.code}) — TravelMate.html opened as a file can't use the API; open http://localhost:${process.env.PORT || 3000}/ instead.`);
      key = null;
    }
  }
  localKey = key;
  return key;
}

/** Whether `sent` (the X-TravelMate-Key header) is this server's key. */
function localKeyMatches(sent) {
  if (!localKey || typeof sent !== 'string' || sent.length !== localKey.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(localKey));
}

module.exports = { ensureLocalKey, localKeyMatches, keyFileSource, KEY_PATTERN };
