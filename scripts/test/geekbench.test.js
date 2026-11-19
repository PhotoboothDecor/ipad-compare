const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseChart, chipClass, conversionRatio, applyChart } = require('../lib/geekbench');
const { validateCatalog } = require('../lib/validate');
const { slugify } = require('../lib/names');

const FIX = path.join(__dirname, 'fixtures');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const gb6 = parseChart(read('gb6-2026-07-18.html'));
const gb7a = parseChart(read('gb7-2026-10-31.html'));
const gb7b = parseChart(read('gb7-2026-11-19.html'));

const stripChip = (c) => c.replace(/^Apple /, '').replace(/ Bionic$/, '');

function baseModel(name, chip, extra = {}) {
  return {
    id: slugify(name), name, family: 'ipad', size_in: null, chip,
    released: 2020, a_numbers: [], max_os_major: 18, apple_topic_id: null,
    names: { apple: [], geekbench: [name], aliases: [] },
    score_status: 'pending', score: null, ...extra,
  };
}

function buildCatalog() {
  const models = gb6.devices.map((d) => baseModel(d.name, stripChip(d.chip)));
  models.push(baseModel('iPad mini (A20 Pro)', 'A20 Pro'));
  return { schema_version: 1, updated: '2026-11-19', latest_ipados: 27, models };
}

const withGb6Gb7 = () => applyChart(applyChart(buildCatalog(), gb6, { captured: '2026-07-18' }).catalog, gb7a, { captured: '2026-10-31' }).catalog;
const byName = (cat, n) => cat.models.find((m) => m.name === n);

test('parseChart gb6', () => {
  assert.equal(gb6.version, 6);
  assert.equal(gb6.devices.length, 35);
  assert.deepEqual(gb6.devices.find((d) => d.name === 'iPad mini 4'), { name: 'iPad mini 4', chip: 'Apple A8', single: 412, multi: 602 });
  // 9-core/10-core variants share a name: the base (lower) one is kept
  assert.equal(gb6.devices.find((d) => d.name === 'iPad Pro 11-inch (M4)').multi, 13259);
  const m7 = gb6.devices.find((d) => d.name === 'iPad mini (7th generation)');
  assert.equal(m7.chip, 'Apple A17 Pro');
  assert.equal(m7.single, 2910);
  assert.equal(m7.multi, 7242);
  const p = gb6.devices.find((d) => d.name === 'iPad Pro 13-inch (M5)');
  assert.equal(p.multi, 15725);
  assert.equal(p.single, 4145);
});

test('parseChart gb7', () => {
  assert.equal(gb7a.version, 7);
  assert.equal(gb7a.devices.length, 26);
  assert.equal(gb7b.version, 7);
  assert.equal(gb7b.devices.length, 27);
  assert.deepEqual(gb7b.devices.find((d) => d.name === 'iPad mini (A20 Pro)'),
    { name: 'iPad mini (A20 Pro)', chip: 'Apple A20 Pro', single: 3958, multi: 10377 });
});

test('parseChart rejects bad input', () => {
  assert.throws(() => parseChart('<html><body><p>nothing</p></body></html>'));
  assert.throws(() => parseChart(read('gb6-2026-07-18.html').replace(/Geekbench 6/g, 'Geekbench')));
});

test('chipClass', () => {
  assert.equal(chipClass('M5'), 'M');
  assert.equal(chipClass('A12X'), 'AX');
  assert.equal(chipClass('A12Z'), 'AX');
  assert.equal(chipClass('A17 Pro'), 'A');
  assert.equal(chipClass('A16'), 'A');
});

test('conversionRatio M5 uses same-chip pairs', () => {
  const cat = withGb6Gb7();
  const pairs = cat.models.filter((m) => m.score && m.score.source === 'gb6' && m.score.gb7_multi != null);
  const r = conversionRatio('M5', pairs, 'multi');
  assert.ok(Math.abs(r.ratio - 0.968) < 0.001, `ratio ${r.ratio}`);
  assert.deepEqual([...r.basis].sort(), ['iPad Pro 11-inch (M5)', 'iPad Pro 13-inch (M5)']);
});

test('conversionRatio A20 Pro uses A17 Pro and A16', () => {
  const cat = withGb6Gb7();
  const pairs = cat.models.filter((m) => m.score && m.score.source === 'gb6' && m.score.gb7_multi != null);
  const r = conversionRatio('A20 Pro', pairs, 'multi');
  assert.ok(Math.abs(r.ratio - 0.942) < 0.001, `ratio ${r.ratio}`);
  assert.deepEqual([...r.basis].sort(), ['iPad (11th generation)', 'iPad mini (7th generation)']);
});

test('conversionRatio throws on no pairs or wide spread', () => {
  assert.throws(() => conversionRatio('A20 Pro', [], 'multi'));
  const mk = (name, chip, g6, g7) => baseModel(name, chip, {
    score_status: 'ok',
    score: { gb6_multi: g6, gb6_single: g6, source: 'gb6', gb7_multi: g7, gb7_single: g7, ratio_multi: null, ratio_single: null, captured: 'x' },
  });
  assert.throws(() => conversionRatio('A20 Pro', [mk('a', 'A17 Pro', 1000, 800), mk('b', 'A16', 1000, 1000)], 'multi'), /spread/);
});

test('applyChart gb6 sets measured scores', () => {
  const { catalog } = applyChart(buildCatalog(), gb6, { captured: '2026-07-18' });
  const m = byName(catalog, 'iPad mini (7th generation)');
  assert.equal(m.score_status, 'ok');
  assert.equal(m.score.gb6_multi, 7242);
  assert.equal(m.score.source, 'gb6');
  assert.equal(m.score.captured, '2026-07-18');
  assert.equal(byName(catalog, 'iPad mini (A20 Pro)').score, null);
});

test('applyChart gb7 Nov-19 converts A20 Pro and keeps measured scores', () => {
  const cat = withGb6Gb7();
  const before = JSON.stringify(byName(cat, 'iPad mini (7th generation)').score.gb6_multi);
  const { catalog, report } = applyChart(cat, gb7b, { captured: '2026-11-19' });
  const a20 = byName(catalog, 'iPad mini (A20 Pro)');
  assert.ok(Math.abs(a20.score.gb6_multi - 11016) <= 10, `got ${a20.score.gb6_multi}`);
  assert.equal(a20.score.source, 'gb7-converted');
  assert.equal(a20.score_status, 'ok');
  assert.equal(a20.score.gb7_multi, 10377);
  assert.ok(a20.score.ratio_multi > 0.94 && a20.score.ratio_multi < 0.944);
  assert.equal(JSON.stringify(byName(catalog, 'iPad mini (7th generation)').score.gb6_multi), before);
  assert.equal(byName(catalog, 'iPad mini (7th generation)').score.source, 'gb6');
  assert.equal(byName(catalog, 'iPad mini (7th generation)').score.gb7_multi, 6768);
  assert.equal(report.unmatched.length, 0);
  assert.deepEqual(validateCatalog(catalog, { now: new Date('2026-11-19') }), []);
  // input not mutated
  assert.equal(byName(cat, 'iPad mini (A20 Pro)').score, null);
});

test('applyChart unmatched devices are reported, catalog unchanged', () => {
  const cat = buildCatalog();
  const chart = { version: 7, devices: [{ name: 'iPad Air 11-inch (8th generation)', chip: 'Apple M5', single: 3000, multi: 12000 }] };
  const { catalog, report } = applyChart(cat, chart, { captured: '2026-11-19' });
  assert.deepEqual(report.unmatched.map((d) => d.name), ['iPad Air 11-inch (8th generation)']);
  assert.deepEqual(catalog.models, cat.models);
  assert.equal(catalog.models.length, cat.models.length);
});

test('gb7 import never overwrites measured gb6', () => {
  const cat = withGb6Gb7();
  const { catalog } = applyChart(cat, gb7b, { captured: '2026-11-19' });
  for (const m of cat.models.filter((x) => x.score && x.score.source === 'gb6')) {
    assert.equal(byName(catalog, m.name).score.gb6_multi, m.score.gb6_multi);
    assert.equal(byName(catalog, m.name).score.source, 'gb6');
  }
});

// ---- CLI ----
const CLI = path.join(__dirname, '..', 'import_geekbench.js');
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}
function tmpCatalog(cat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbcli-'));
  const p = path.join(dir, 'catalog.json');
  fs.writeFileSync(p, JSON.stringify(cat));
  return p;
}

test('CLI rejects browser.geekbench.com URLs', () => {
  const p = tmpCatalog(buildCatalog());
  const r = runCli(['https://browser.geekbench.com/ios-benchmarks', '--catalog', p]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /browser\.geekbench\.com/);
});

test('CLI --dry-run does not write; real run writes validated catalog', () => {
  const p = tmpCatalog(buildCatalog());
  const orig = fs.readFileSync(p, 'utf8');
  const d = runCli([path.join(FIX, 'gb6-2026-07-18.html'), '--captured', '2026-07-18', '--catalog', p, '--dry-run']);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
  const w = runCli([path.join(FIX, 'gb6-2026-07-18.html'), '--captured', '2026-07-18', '--catalog', p]);
  assert.equal(w.status, 0, w.stderr);
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(byName(out, 'iPad mini (7th generation)').score.gb6_multi, 7242);
});

test('CLI blocks score moves over 15% unless --accept-large-changes', () => {
  const cat = applyChart(buildCatalog(), gb6, { captured: '2026-07-18' }).catalog;
  byName(cat, 'iPad mini (7th generation)').score.gb6_multi = 3000;
  const p = tmpCatalog(cat);
  const orig = fs.readFileSync(p, 'utf8');
  const r = runCli([path.join(FIX, 'gb6-2026-07-18.html'), '--captured', '2026-07-18', '--catalog', p]);
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
  const r2 = runCli([path.join(FIX, 'gb6-2026-07-18.html'), '--captured', '2026-07-18', '--catalog', p, '--accept-large-changes']);
  assert.equal(r2.status, 0, r2.stderr);
});
