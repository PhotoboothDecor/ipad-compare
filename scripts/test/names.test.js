const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName, slugify } = require('../lib/names');

test('slugify', () => {
  assert.equal(slugify('iPad Air 11-inch (M4)'), 'ipad-air-11-m4');
  assert.equal(slugify('iPad (A16)'), 'ipad-a16');
  assert.equal(slugify('iPad Pro 12.9-inch (6th generation)'), 'ipad-pro-12-9-6th-generation');
});

test('normalizeName', () => {
  assert.equal(normalizeName('iPad Pro 11‑inch (M4)'), 'ipad pro 11-inch m4');
  assert.equal(normalizeName('iPad Air  (M2) '), 'ipad air m2');
});
