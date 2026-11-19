const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog } = require('../lib/validate');

const now = new Date('2026-11-19T00:00:00Z');

function model(over = {}) {
  return {
    id: 'ipad-air-11-m4',
    name: 'iPad Air 11-inch (M4)',
    family: 'air',
    size_in: 11,
    chip: 'M4',
    released: 2026,
    a_numbers: ['A3459'],
    max_os_major: 27,
    apple_topic_id: 'g0mrwneq8sk5',
    names: { apple: [], geekbench: [], aliases: [] },
    score_status: 'ok',
    score: {
      gb6_multi: 13259, gb6_single: 3700, source: 'gb6',
      gb7_multi: 13260, gb7_single: 3235,
      ratio_multi: null, ratio_single: null, captured: '2026-07-18',
    },
    ...over,
  };
}
function second(over = {}) {
  return model({
    id: 'ipad-a16', name: 'iPad (A16)', family: 'ipad', size_in: 11, chip: 'A16',
    released: 2025, a_numbers: ['A3354'], apple_topic_id: null,
    score: { ...model().score, gb6_multi: 5000 }, ...over,
  });
}
function cat(models, over = {}) {
  return { schema_version: 1, updated: '2026-11-19', latest_ipados: 27, models, ...over };
}
function has(errors, id, frag) {
  assert.ok(errors.some((e) => e.includes(id) && (!frag || e.toLowerCase().includes(frag))),
    `expected error with "${id}"${frag ? ` / "${frag}"` : ''}, got ${JSON.stringify(errors)}`);
}

test('minimal valid catalog', () => {
  assert.deepEqual(validateCatalog(cat([model(), second()]), { now }), []);
});

test('generation: optional integer or null', () => {
  assert.deepEqual(validateCatalog(cat([model({ generation: 7 }), second({ generation: null })]), { now }), []);
  has(validateCatalog(cat([model({ generation: '7' })]), { now }), 'ipad-air-11-m4', 'generation');
  has(validateCatalog(cat([model({ generation: 6.5 })]), { now }), 'ipad-air-11-m4', 'generation');
  has(validateCatalog(cat([model({ generation: 0 })]), { now }), 'ipad-air-11-m4', 'generation');
});

test('duplicate id', () => {
  const e = validateCatalog(cat([model(), second({ id: 'ipad-air-11-m4' })]), { now });
  has(e, 'ipad-air-11-m4', 'duplicate');
});

test('duplicate A-number across models', () => {
  const e = validateCatalog(cat([model(), second({ a_numbers: ['A3459'] })]), { now });
  has(e, 'ipad-a16', 'a3459');
});

test('A-number format', () => {
  const e = validateCatalog(cat([model({ a_numbers: ['A12345'] })]), { now });
  has(e, 'ipad-air-11-m4');
});

test('shared normalized name/alias', () => {
  const e = validateCatalog(cat([model(), second({ names: { apple: [], geekbench: [], aliases: ['iPad Air 11‑inch (M4)'] } })]), { now });
  has(e, 'ipad-a16', 'name');
});

test('score_status ok with null score', () => {
  const e = validateCatalog(cat([model({ score: null })]), { now });
  has(e, 'ipad-air-11-m4');
});

for (const v of [10000, 9660, 10100, 14500]) {
  test(`blacklisted gb6_multi ${v}`, () => {
    const m = model(); m.score.gb6_multi = v;
    has(validateCatalog(cat([m]), { now }), 'ipad-air-11-m4', 'gb6_multi');
  });
}

for (const v of [299, 30001]) {
  test(`gb6_multi out of range ${v}`, () => {
    const m = model(); m.score.gb6_multi = v;
    has(validateCatalog(cat([m]), { now }), 'ipad-air-11-m4', 'gb6_multi');
  });
}

test('released in the future', () => {
  has(validateCatalog(cat([model({ released: 2027 })]), { now }), 'ipad-air-11-m4', 'released');
});

test('max_os_major above latest_ipados', () => {
  has(validateCatalog(cat([model({ max_os_major: 28 })]), { now }), 'ipad-air-11-m4', 'max_os_major');
});

test('gb7-converted ratio out of range', () => {
  const m = model(); m.score.source = 'gb7-converted'; m.score.ratio_multi = 1.5; m.score.ratio_single = 1.0;
  has(validateCatalog(cat([m]), { now }), 'ipad-air-11-m4', 'ratio');
});

test('gb7-converted null ratio', () => {
  const m = model(); m.score.source = 'gb7-converted'; m.score.ratio_multi = null;
  has(validateCatalog(cat([m]), { now }), 'ipad-air-11-m4', 'ratio');
});

test('gb7-converted null gb7_multi', () => {
  const m = model(); m.score.source = 'gb7-converted'; m.score.ratio_multi = 1.0; m.score.ratio_single = 1.0; m.score.gb7_multi = null;
  has(validateCatalog(cat([m]), { now }), 'ipad-air-11-m4', 'gb7_multi');
});

test('gb7-converted valid', () => {
  const m = model(); m.score.source = 'gb7-converted'; m.score.ratio_multi = 1.0; m.score.ratio_single = 1.0;
  assert.deepEqual(validateCatalog(cat([m, second()]), { now }), []);
});

test('previous: model count drop', () => {
  const prev = cat([model(), second()]);
  const e = validateCatalog(cat([model()]), { previous: prev, now });
  has(e, 'catalog', 'count');
});

test('previous: missing id', () => {
  const prev = cat([model(), second()]);
  const e = validateCatalog(cat([model(), second({ id: 'ipad-a17', a_numbers: ['A9999'], name: 'iPad (A17)' })]), { previous: prev, now });
  has(e, 'ipad-a16', 'missing');
});
