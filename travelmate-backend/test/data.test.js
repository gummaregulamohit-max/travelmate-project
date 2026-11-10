// Regression checks for the bundled station and location data. The expected
// counts are a snapshot of commit 75539df — when the data is updated on
// purpose, update SNAPSHOT in the same commit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'data');
const { loadStations, findStationByCode } = require(path.join(ROOT, 'src/services/stations.service'));
const { directoryStats, searchLocations } = require(path.join(ROOT, 'src/services/locations.service'));

const SNAPSHOT = {
  majorStations: 46,
  fullStations: 8952,
  stationDirectory: 8956,
  retiringRoomStations: 288,
  // +1: Shivamogga Airport (RQY). With an airport, Shivamogga also takes in
  // the "Shimoga Bidare" (BEI) station, so one town entry merges into it.
  airports: 4009,
  places: { places: 162512, hidden: 3587, cities: 5822, towns: 7697, villages: 148993 }
};

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));

test('every bundled data file exists', () => {
  for (const file of ['major-stations.json', 'stations-full.json', 'retiring-room-stations.json', 'airports.json',
    'places.tsv.gz', 'busPoints.js', 'carriers.js', 'knownTrainRoutes.js']) {
    assert.ok(fs.existsSync(path.join(DATA, file)), `missing src/data/${file}`);
  }
});

test('bundled JSON files parse and have the expected sizes', () => {
  assert.equal(readJson('major-stations.json').length, SNAPSHOT.majorStations);
  assert.equal(readJson('stations-full.json').length, SNAPSHOT.fullStations);
  assert.equal(readJson('retiring-room-stations.json').length, SNAPSHOT.retiringRoomStations);
  assert.equal(readJson('airports.json').length, SNAPSHOT.airports);
});

test('places.tsv.gz decompresses', () => {
  const text = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'places.tsv.gz'))).toString('utf8');
  assert.ok(text.split('\n').length > 150000);
});

test('the bundled JS data modules load', () => {
  for (const file of ['busPoints.js', 'carriers.js', 'knownTrainRoutes.js']) {
    assert.doesNotThrow(() => require(path.join(DATA, file)), file);
  }
});

test('every major station has a category, name, code, city and state', () => {
  for (const s of readJson('major-stations.json')) {
    for (const key of ['category', 'name', 'code', 'city', 'state']) {
      assert.ok(s[key], `${s.code || JSON.stringify(s)} is missing ${key}`);
    }
  }
});

test('the merged station directory has unique, well-formed codes and names', () => {
  const stations = loadStations();
  assert.equal(stations.length, SNAPSHOT.stationDirectory);
  assert.equal(new Set(stations.map((s) => s.code)).size, stations.length, 'duplicate station codes');
  for (const s of stations) {
    assert.match(s.code, /^[A-Z0-9]{1,5}$/, `bad code ${JSON.stringify(s)}`);
    assert.ok(s.name, `station ${s.code} has no name`);
  }
});

test('major stations come first in the directory', () => {
  const majorCodes = readJson('major-stations.json').map((s) => s.code);
  assert.deepEqual(loadStations().slice(0, majorCodes.length).map((s) => s.code), majorCodes);
});

test('landmark stations are present', () => {
  assert.deepEqual(findStationByCode('CSMT'), {
    category: 'Metropolitan Hub', name: 'Chhatrapati Shivaji Maharaj Terminus', code: 'CSMT', city: 'Mumbai', state: 'Maharashtra'
  });
  for (const code of ['MMCT', 'LTT', 'NDLS', 'HWH', 'MAS', 'SBC', 'KCG', 'SC']) {
    assert.ok(findStationByCode(code), `station ${code} is missing`);
  }
  assert.equal(findStationByCode(' csmt ').code, 'CSMT', 'lookup trims and upper-cases');
});

test('every retiring-room station exists in the directory, once', () => {
  const codes = readJson('retiring-room-stations.json');
  assert.equal(new Set(codes).size, codes.length, 'duplicate retiring-room codes');
  for (const code of codes) assert.ok(findStationByCode(code), `retiring-room station ${code} is not in the directory`);
});

test('airports include BOM and DEL', () => {
  const airports = readJson('airports.json');
  for (const code of ['BOM', 'DEL', 'NMI']) assert.ok(airports.some((a) => a.code === code), `airport ${code} is missing`);
});

test('Shivamogga Airport (RQY) is in the backend and frontend airport lists', () => {
  assert.deepEqual(readJson('airports.json').find((a) => a.code === 'RQY'),
    { code: 'RQY', name: 'Shivamogga Airport', city: 'Shivamogga', country: 'India', continent: 'Asia' });
  const html = fs.readFileSync(path.join(ROOT, '..', 'TravelMate.html'), 'utf8');
  const line = html.split('\n').find((l) => l.includes('const FLIGHT_AIRPORTS_ALL'));
  const { airports } = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
  assert.deepEqual(airports.find((a) => a[0] === 'RQY'), ['RQY', 'Shivamogga Airport', 'Shivamogga', 'IN', 'AS', 1, 'Shimoga, Sogane']);
  assert.equal(airports.length, SNAPSHOT.airports, 'frontend and backend list the same number of airports');
});

test('Shivamogga offers flights (RQY), trains and buses', () => {
  const [place] = searchLocations('Shivamogga', { limit: 1 });
  assert.equal(place.name, 'Shivamogga');
  assert.deepEqual(place.points.airports.map((a) => a.code), ['RQY']);
  for (const code of ['SME', 'SMET']) assert.ok(place.points.stations.some((s) => s.code === code), `station ${code}`);
  assert.deepEqual(place.modes, ['flights', 'trains', 'buses']);
});

test('the location directory has the expected size', () => {
  const stats = directoryStats();
  for (const [key, value] of Object.entries(SNAPSHOT.places)) assert.equal(stats[key], value, key);
});

test('major cities resolve to themselves', () => {
  for (const city of ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Kolkata', 'Hyderabad']) {
    assert.equal(searchLocations(city, { limit: 1 })[0]?.name, city);
  }
});
