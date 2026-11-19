'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const config = require(path.join(__dirname, '..', '..', 'firebase.json'));

test('firebase.json hosting headers match the Firebase schema', () => {
  const rules = config.hosting.headers;
  assert.ok(Array.isArray(rules) && rules.length > 0);
  for (const rule of rules) {
    assert.deepEqual(Object.keys(rule).sort(), ['headers', 'source']);
    assert.equal(typeof rule.source, 'string');
    assert.ok(Array.isArray(rule.headers) && rule.headers.length > 0);
    for (const h of rule.headers) {
      assert.deepEqual(Object.keys(h).sort(), ['key', 'value']);
      assert.equal(typeof h.key, 'string');
      assert.equal(typeof h.value, 'string');
    }
  }
});

test('firebase.json sends no-cache for "/" and for data/code files, once each', () => {
  const rules = config.hosting.headers;
  for (const source of ['/', '**/*.@(json|js|css|html)']) {
    const matches = rules.filter((r) => r.source === source);
    assert.equal(matches.length, 1, `exactly one rule for ${source}`);
    assert.deepEqual(matches[0].headers, [{ key: 'Cache-Control', value: 'no-cache' }]);
  }
});
