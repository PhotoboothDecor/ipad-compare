const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../public/matcher.js');
const catalog = require('../../public/catalog.json');

const matcher = M.createMatcher(catalog);
const get = (id) => matcher.get(id);
const LATEST = catalog.latest_ipados;

test('pending model not ranked', () => {
  const airM4 = get('ipad-air-11-m4');
  assert.equal(airM4.score_status, 'pending');
  assert.equal(M.valueOf(airM4, 799), null);

  const items = [
    { key: 'pending', value: M.valueOf(airM4, 799) },
    { key: 'ipad9', value: M.valueOf(get('ipad-9th-generation'), 200) },
    { key: 'old', value: M.valueOf(get('ipad-2'), 20) },
    { key: 'pro', value: M.valueOf(get('ipad-pro-11-m4'), 900) },
  ];
  for (const direction of ['desc', 'asc']) {
    const sorted = M.rankRows(items, 'value', direction).map((x) => x.key);
    assert.deepEqual(sorted.slice(2).sort(), ['old', 'pending'], `nulls last (${direction})`);
  }
  assert.deepEqual(M.rankRows(items, 'value', 'desc').slice(0, 2).map((x) => x.key), ['ipad9', 'pro']);
  assert.deepEqual(M.rankRows(items, 'value', 'asc').slice(0, 2).map((x) => x.key), ['pro', 'ipad9']);

  assert.equal(M.pickBest(items).key, 'ipad9');
  // A pending row alone, or with other unscored rows, is never best.
  assert.equal(M.pickBest([{ value: null }, { value: null }]), null);
  assert.equal(M.pickBest([]), null);
});

test('rankRows sorts strings, keeps nulls last, does not mutate', () => {
  const items = [{ model: 'b', price: 3 }, { model: 'A', price: null }, { model: 'c', price: 1 }];
  assert.deepEqual(M.rankRows(items, 'model', 'asc').map((x) => x.model), ['A', 'b', 'c']);
  assert.deepEqual(M.rankRows(items, 'price', 'desc').map((x) => x.model), ['b', 'c', 'A']);
  assert.deepEqual(M.rankRows(items, 'price', 'asc').map((x) => x.model), ['c', 'b', 'A']);
  assert.deepEqual(items.map((x) => x.model), ['b', 'A', 'c']);
});

test('valueOf: gb6_multi / price, null for bad price or no score', () => {
  const ipad9 = get('ipad-9th-generation');
  assert.equal(M.valueOf(ipad9, 200), ipad9.score.gb6_multi / 200);
  assert.equal(M.valueOf(ipad9, 0), null);
  assert.equal(M.valueOf(ipad9, -5), null);
  assert.equal(M.valueOf(ipad9, NaN), null);
  assert.equal(M.valueOf(ipad9, '200'), ipad9.score.gb6_multi / 200);
  assert.equal(M.valueOf(get('ipad-2'), 50), null); // unsupported
  assert.equal(M.valueOf(null, 50), null);
  // converted scores still count
  const mini = get('ipad-mini-a20-pro');
  assert.equal(mini.score.source, 'gb7-converted');
  assert.equal(M.valueOf(mini, 500), mini.score.gb6_multi / 500);
});

test('displayMaxOS cases', () => {
  assert.equal(M.displayMaxOS(get('ipad-mini-4'), LATEST), 'iPadOS 15');
  assert.equal(M.displayMaxOS(get('ipad-pro-11-m4'), LATEST), 'Latest (iPadOS 27)');
  assert.equal(M.displayMaxOS(get('ipad-2'), LATEST), 'iOS 9');
  assert.equal(M.displayMaxOS(get('ipad-air'), LATEST), 'iOS 12');
  assert.equal(M.displayMaxOS({ max_os_major: 13 }, 27), 'iPadOS 13');
});

test('migrates saved rows', () => {
  const out = M.migrateSaved([
    { model: 'iPad Air (6th)', price: '450', score: '9000', valueScore: '20.00' },
    { model: 'iPadOS 16.1', price: '120' },
    { model: 'iPad (9th generation)', price: 200 },
    { model: 'A2602', price: '199' },
    { id: 'ipad-pro-11', model: 'whatever', price: 380 },
    { id: 'gone-model', model: 'iPad mini (6th generation)', price: 425 },
  ], matcher);

  // Old "iPad Air (6th)" -> the 6th-gen Air. Two sizes share that generation,
  // so it is offered as a choice between them, never auto-picked.
  assert.equal(out[0].id, null);
  assert.equal(out[0].model, 'iPad Air (6th)');
  assert.equal(out[0].price, 450);
  assert.ok(out[0].candidates.length === 2);
  for (const id of out[0].candidates) {
    assert.equal(get(id).family, 'air');
    assert.equal(get(id).generation, 6);
  }

  assert.deepEqual(out[1], { id: null, model: 'iPadOS 16.1', price: 120, candidates: [] });
  assert.deepEqual(out[2], { id: 'ipad-9th-generation', model: 'iPad (9th generation)', price: 200 });
  assert.deepEqual(out[3], { id: 'ipad-9th-generation', model: 'iPad (9th generation)', price: 199 });
  assert.deepEqual(out[4], { id: 'ipad-pro-11', model: 'iPad Pro 11-inch', price: 380 });
  assert.deepEqual(out[5], { id: 'ipad-mini-6th-generation', model: 'iPad mini (6th generation)', price: 425 });
});

test('migrateSaved never crashes on junk', () => {
  assert.deepEqual(M.migrateSaved(null, matcher), []);
  assert.deepEqual(M.migrateSaved('nope', matcher), []);
  const out = M.migrateSaved([null, 5, {}, { model: 'iPad 9', price: 'abc' }, { price: 100 }], matcher);
  assert.deepEqual(out, [{ id: null, model: 'Unknown model', price: 100, candidates: [] }]);
});

test('resolveMatch: unambiguous top -> id; ambiguous -> tied candidates; none -> null', () => {
  assert.deepEqual(M.resolveMatch(matcher.find('A2602')), { id: 'ipad-9th-generation', candidates: [] });
  const amb = M.resolveMatch(matcher.find('ipad air m4'));
  assert.equal(amb.id, null);
  assert.deepEqual(amb.candidates.slice().sort(), ['ipad-air-11-m4', 'ipad-air-13-m4']);
  const fam = M.resolveMatch(matcher.find('ipad mini'));
  assert.equal(fam.id, null);
  assert.ok(fam.candidates.length >= 2);
  assert.deepEqual(M.resolveMatch([]), { id: null, candidates: [] });
});
