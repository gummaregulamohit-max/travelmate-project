// Starts the real server.js in a child process for HTTP tests. Every external
// API key is blanked (dotenv never overrides a variable that is already set),
// so no test can reach SerpApi, RapidAPI or Amadeus, even with a filled .env.

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    }).on('error', reject);
  });
}

// `env` adds or overrides variables after the blanking — only ever fake
// placeholder values, e.g. to check a key never shows up in a response.
async function startServer({ env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // Live IRCTC requests off and a throwaway usage file, whatever .env says.
    env: {
      ...process.env, PORT: String(port), SERPAPI_KEY: '', RAPIDAPI_KEY: '', AMADEUS_CLIENT_ID: '', AMADEUS_CLIENT_SECRET: '',
      TRAIN_API_REQUEST_BUDGET: '0', TRAIN_API_USAGE_FILE: path.join(os.tmpdir(), `travelmate-test-usage-${port}.json`), ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server.js did not start within 15s:\n${output}`)), 15000);
    child.stdout.on('data', (d) => {
      output += d;
      if (output.includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server.js exited with code ${code}:\n${output}`)); });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    async request(urlPath, init) {
      const res = await fetch(baseUrl + urlPath, init);
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, body: JSON.parse(text) };
    },
    get(urlPath) { return this.request(urlPath); },
    stop() { return new Promise((resolve) => { child.once('exit', resolve); child.kill(); }); }
  };
}

module.exports = { startServer };
