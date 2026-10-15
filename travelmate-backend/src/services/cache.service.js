// Minimal in-memory TTL cache. Amadeus's free "test" tier has a limited monthly
// call quota, so identical searches within a short window are served from cache
// instead of hitting the API again. Swap for Redis if you run more than one process.

const store = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

module.exports = { getCached, setCached };
