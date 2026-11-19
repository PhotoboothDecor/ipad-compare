const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../public/matcher.js');
const catalog = require('../../public/catalog.json');

const matcher = M.createMatcher(catalog);
const find = (q, limit) => matcher.find(q, limit);
const top = (q) => (find(q)[0] || {}).id;
const model = (id) => matcher.get(id);

test('a-number exact: A2602, a2602, "Model A2602" return only iPad (9th generation)', () => {
  for (const q of ['A2602', 'a2602', 'Model A2602', 'iPad model a2602 64GB']) {
    const r = find(q);
    assert.equal(r.length, 1, q);
    assert.equal(r[0].id, 'ipad-9th-generation', q);
    assert.equal(r[0].matchType, 'number', q);
    assert.equal(r[0].ambiguous, false, q);
  }
  assert.equal(matcher.byANumber('a2602').id, 'ipad-9th-generation');
  assert.equal(matcher.byANumber('Model A2602').id, 'ipad-9th-generation');
  assert.equal(matcher.byANumber('A0000'), null);
});

test('get by id', () => {
  assert.equal(matcher.get('ipad-air-11-m2').name, 'iPad Air 11-inch (M2)');
  assert.equal(matcher.get('nope'), null);
});

test('year disambiguates: iPad Pro 11 2018 -> 1st-gen 11-inch', () => {
  assert.equal(top('iPad Pro 11 2018'), 'ipad-pro-11');
  assert.equal(top('ipad pro 12.9 2018'), 'ipad-pro-12-9-3rd-generation');
});

test('ipad air m3 -> an M3 Air with score ok', () => {
  const m = model(top('ipad air m3'));
  assert.equal(m.family, 'air');
  assert.equal(m.chip, 'M3');
  assert.equal(m.score_status, 'ok');
});

test('ipad air 6 -> M2 Airs, no junk', () => {
  for (const q of ['ipad air 6', 'air 6th gen', 'iPad Air 6th generation']) {
    const r = find(q);
    assert.deepEqual(r.map((x) => x.id).sort(), ['ipad-air-11-m2', 'ipad-air-13-m2'], q);
    assert.equal(model(r[0].id).chip, 'M2', q);
  }
  assert.equal(top('ipad air 6 11 inch'), 'ipad-air-11-m2');
  assert.equal(top('ipad air 6th gen 13"'), 'ipad-air-13-m2');
  assert.equal(find('ipad air 6 13-inch').length, 1);
});

test('ipad mini a20 -> iPad mini (A20 Pro)', () => {
  assert.equal(top('ipad mini a20'), 'ipad-mini-a20-pro');
  assert.equal(top('iPad mini A17 Pro'), 'ipad-mini-a17-pro');
});

test('generation numbers per family', () => {
  assert.equal(top('ipad 9'), 'ipad-9th-generation');
  assert.equal(top('ipad 10th gen'), 'ipad-10th-generation');
  assert.equal(top('ipad 11'), 'ipad-a16');
  assert.equal(top('ipad air 2'), 'ipad-air-2');
  assert.equal(top('ipad mini 4'), 'ipad-mini-4');
  assert.equal(top('ipad pro 12.9 3rd generation'), 'ipad-pro-12-9-3rd-generation');
  assert.equal(top('iPad Pro 11-inch (4th generation)'), 'ipad-pro-11-4th-generation');
  assert.equal(top('ipad pro 13 m4'), 'ipad-pro-13-m4');
  assert.equal(top('IPAD PRO 10.5'), 'ipad-pro-10-5');
  assert.equal(top('ipad 9 in great shape'), 'ipad-9th-generation'); // "in" is not "inch"
  assert.equal(top('ipad pro 11\u2011inch m4'), 'ipad-pro-11-m4');
  assert.equal(top('iPad Pro 12.9-inch (3rd generation)'), 'ipad-pro-12-9-3rd-generation');
  // "ipad 5" must prefer the base iPad over Air 5 / mini 5
  assert.equal(top('ipad 5'), 'ipad-5th-generation');
});

test('"ipad" alone -> []', () => {
  assert.deepEqual(find('ipad'), []);
  assert.deepEqual(find('Apple iPad'), []);
  assert.deepEqual(find('   '), []);
});

test('bare family queries are ambiguous, newest first', () => {
  for (const [q, fam] of [['ipad air', 'air'], ['iPad mini', 'mini'], ['ipad pro', 'pro'], ['Apple iPad Air', 'air']]) {
    const r = find(q, 100);
    const famIds = catalog.models.filter((m) => m.family === fam).map((m) => m.id);
    assert.deepEqual(r.map((x) => x.id).sort(), famIds.sort(), q);
    assert.ok(r.every((x) => x.ambiguous === true), q);
    for (let i = 1; i < r.length; i++) {
      assert.ok(model(r[i - 1].id).released >= model(r[i].id).released, q);
    }
  }
  // Exact Apple names for the 2013/2012 models are still ambiguous on their own
  assert.equal(find('iPad Air')[0].ambiguous, true);
});

test('non-ambiguous results carry ambiguous:false and the documented shape', () => {
  for (const q of ['ipad air 6', 'a2602', 'ipad pro 11 2018', 'ipad mini a20', 'm4']) {
    for (const r of find(q)) {
      assert.deepEqual(Object.keys(r).sort(), ['ambiguous', 'id', 'matchType', 'name', 'relevance']);
      assert.equal(r.ambiguous, false, q);
      assert.ok(['number', 'name', 'cpu', 'year', 'fuzzy'].includes(r.matchType), q);
    }
  }
});

test('results are deduped by id and limited', () => {
  const r = find('m2', 3);
  assert.ok(r.length <= 3);
  const all = find('2024', 100);
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  assert.ok(all.length > 0 && all.every((x) => model(x.id).released === 2024));
});

test('no result is ever an OS name or junk', () => {
  const queries = ['ipad', 'ipad air', 'ipad pro', 'ipad mini', 'ipad air 6', 'ios 12', 'ipados 17', '2020', 'a12', 'm1', 'ipad 6', '‹', 'pro 11'];
  for (const q of queries) {
    for (const r of find(q, 100)) {
      assert.ok(!/^(iPadOS|iOS|‹)/.test(r.name), `${q} -> ${r.name}`);
      assert.ok(model(r.id), `${q} -> ${r.id}`);
    }
  }
});

test('marketplace paste: parseFacebookBlocks + cleanTitle + find', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'marketplace-paste.txt'), 'utf8');
  const blocks = M.parseFacebookBlocks(text);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.price), [450, 380, 425]);
  assert.ok(blocks.every((b) => M.isIPadListing(b.rawTitle)));
  const ids = blocks.map((b) => top(M.cleanTitle(b.rawTitle)));
  assert.deepEqual(ids, ['ipad-air-5th-generation', 'ipad-pro-11', 'ipad-mini-6th-generation']);
});

test('parse helpers keep their behavior', () => {
  assert.equal(M.parseFacebookBlocks('just some text\nno listings'), null);
  assert.equal(M.isIPadListing('Case for iPad Air'), false);
  assert.equal(M.isIPadListing('Samsung Galaxy Tab like iPad'), false);
  assert.equal(M.isIPadListing('iPad Air 5 64GB'), true);
  assert.equal(M.cleanTitle('Apple iPad 9e génération 64GB Silver'), 'iPad 9th generation');
  assert.equal(M.getOrdinal(2), '2nd');
  assert.equal(M.getOrdinal(11), '11th');
});
