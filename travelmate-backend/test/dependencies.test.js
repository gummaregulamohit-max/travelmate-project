// Every runtime dependency must be used by the backend, so packages that are
// no longer needed (like xlsx and pdf-parse were) don't creep back in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const lock = require(path.join(ROOT, 'package-lock.json'));

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const source = [path.join(ROOT, 'server.js'), ...sourceFiles(path.join(ROOT, 'src'))]
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

test('every dependency in package.json is required by the backend', () => {
  for (const dep of Object.keys(pkg.dependencies || {})) {
    assert.ok(source.includes(`require('${dep}')`) || source.includes(`require("${dep}")`), `${dep} is listed but never required`);
  }
});

test('xlsx and pdf-parse are not dependencies any more', () => {
  for (const dep of ['xlsx', 'pdf-parse']) {
    assert.equal(pkg.dependencies?.[dep], undefined, `${dep} is still in package.json`);
    assert.equal(lock.packages?.['']?.dependencies?.[dep], undefined, `${dep} is still in package-lock.json`);
    assert.equal(lock.packages?.[`node_modules/${dep}`], undefined, `${dep} is still locked`);
  }
});

test('package.json and package-lock.json list the same dependencies', () => {
  assert.deepEqual(Object.keys(lock.packages[''].dependencies).sort(), Object.keys(pkg.dependencies).sort());
});
