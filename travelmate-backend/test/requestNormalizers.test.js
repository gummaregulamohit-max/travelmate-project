const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { queryString, parseLimit } = require(path.join(ROOT, 'src/utils/requestNormalizers'));

test('queryString: a string is trimmed', () => {
  assert.equal(queryString('  CSMT '), 'CSMT');
  assert.equal(queryString(''), '');
  assert.equal(queryString('   '), '');
});

test('queryString: a repeated parameter uses its first value', () => {
  assert.equal(queryString(['CSMT', 'MMCT']), 'CSMT');
  assert.equal(queryString([' Mumbai ', 'Delhi']), 'Mumbai');
});

test('queryString: missing or non-string values are empty', () => {
  for (const value of [undefined, null, 5, {}, { x: 'CSMT' }, [], [{ x: 'CSMT' }]]) {
    assert.equal(queryString(value), '', JSON.stringify(value));
  }
});

test('parseLimit: whole numbers are clamped to 1..max', () => {
  assert.equal(parseLimit('5'), 5);
  assert.equal(parseLimit('0'), 1);
  assert.equal(parseLimit('-5'), 1);
  assert.equal(parseLimit('100'), 100);
  assert.equal(parseLimit('500'), 100);
  assert.equal(parseLimit(' 7 '), 7);
});

test('parseLimit: missing or non-numeric values fall back to the default', () => {
  for (const value of [undefined, '', 'abc', '2.5', '5abc', '1e3', {}]) {
    assert.equal(parseLimit(value), 20, JSON.stringify(value));
  }
});

test('parseLimit: a repeated limit uses its first value', () => {
  assert.equal(parseLimit(['3', '50']), 3);
});

test('parseLimit: fallback and max can be set', () => {
  assert.equal(parseLimit(undefined, { fallback: 5 }), 5);
  assert.equal(parseLimit('80', { max: 50 }), 50);
});
