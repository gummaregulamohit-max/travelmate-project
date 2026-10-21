// A separate backend process for the cross-process budget tests. Waits until
// `startAt` (so all workers start together), then makes `attempts` attempts and
// prints { ok, requests, reasons } as JSON. axios.get is stubbed — nothing
// leaves the machine.
//   node reserve-worker.js reserve <attempts> <startAt>   reserveRequest() only
//   node reserve-worker.js lookup  <attempts> <startAt>   the full lookupTrain() path

const axios = require('axios');
const irctc = require('../../src/services/irctc.service');

const [mode, attempts, startAt] = [process.argv[2], parseInt(process.argv[3], 10), parseInt(process.argv[4], 10)];
let requests = 0;
axios.get = async (url) => {
  if (!url.includes('rapidapi.com')) throw new Error(`unexpected request: ${url}`);
  requests += 1;
  await new Promise((r) => setTimeout(r, 2));
  return { status: 200, headers: {}, data: { body: [{ trains: [] }] } };
};
console.warn = () => {};

(async () => {
  while (Date.now() < startAt) { /* start together */ }
  let ok = 0;
  const reasons = {};
  for (let i = 0; i < attempts; i++) {
    try {
      if (mode === 'reserve') irctc.reserveRequest();
      else await irctc.lookupTrain(`${process.pid}${i}`);
      ok += 1;
    } catch (err) {
      reasons[err.reason || err.message] = (reasons[err.reason || err.message] || 0) + 1;
    }
  }
  process.stdout.write(JSON.stringify({ ok, requests, reasons }));
})();
