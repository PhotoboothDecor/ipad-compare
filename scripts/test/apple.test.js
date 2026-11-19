const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseIdentifyPage, parseCompatPage, diffCatalog, makeFetchApple, summarize, USER_AGENT,
} = require('../lib/apple');
const { run } = require('../check_apple');
const { normalizeName, slugify } = require('../lib/names');
const { validateCatalog } = require('../lib/validate');

const FIX = path.join(__dirname, 'fixtures');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const identifyHtml = read('apple-identify-108043.html');
const compatHtml = { 27: read('apple-compat-27.html'), 26: read('apple-compat-26.html'), 17: read('apple-compat-17.html'), 15: read('apple-compat-15.html') };

const identify = parseIdentifyPage(identifyHtml);
const compat = Object.fromEntries(Object.entries(compatHtml).map(([v, h]) => [v, parseCompatPage(h)]));
const allCompat = Object.values(compat);
const byId = (cat, id) => cat.models.find((m) => m.id === id);

function model(name, extra = {}) {
  return {
    id: slugify(name), name, family: 'ipad', size_in: null, chip: 'A8', released: 2020,
    a_numbers: [], max_os_major: 18, apple_topic_id: null,
    names: { apple: [], geekbench: [], aliases: [] },
    score_status: 'pending', score: null, ...extra,
  };
}

// Where the identify page and the compat guides name a model differently, the catalog carries
// the guide's name in names.apple or the topic id (Task 4 builds the real catalog this way).
const CATALOG_EXTRAS = {
  'iPad': { id: 'ipad-original' },
  'iPad Pro 11-inch': { names: { apple: ['iPad Pro 11-inch (1st generation)'], geekbench: [], aliases: [] } },
  'iPad Pro (12.9-inch)': { apple_topic_id: 'ipad0012b470' },
};

// Every identify-page model except the ones named in `omit`, with Apple's A-numbers.
// Max OS is deliberately stale (13 for 2015+ models, 9 for older) so the diff has work to do.
function catalogFrom(omit = []) {
  const skip = new Set(omit.map(normalizeName));
  const models = identify
    .filter((m) => !skip.has(normalizeName(m.name)))
    .map((m) => model(m.name, {
      a_numbers: [...m.a_numbers].sort(), released: m.year, max_os_major: m.year >= 2015 ? 13 : 9,
      ...CATALOG_EXTRAS[m.name],
    }));
  return { schema_version: 1, updated: '2026-11-19', latest_ipados: 27, models };
}

test('parseIdentifyPage: every model, A-numbers scoped to its own section', () => {
  assert.ok(identify.length >= 46, `got ${identify.length} models`);
  const air = identify.find((m) => normalizeName(m.name) === normalizeName('iPad Air 11-inch (M4)'));
  assert.ok(air, 'iPad Air 11-inch (M4) present');
  assert.ok(air.a_numbers.length >= 1);
  assert.ok(air.a_numbers.every((a) => /^A\d{4}$/.test(a)));
  assert.equal(air.year, 2026);
  const owner = new Map();
  for (const m of identify) {
    assert.ok(m.a_numbers.length <= 6, `${m.name} has ${m.a_numbers.length} A-numbers`);
    assert.ok(Number.isInteger(m.year) && m.year >= 2010, `${m.name} year ${m.year}`);
    for (const a of m.a_numbers) {
      assert.ok(!owner.has(a), `${a} under ${owner.get(a)} and ${m.name}`);
      owner.set(a, m.name);
    }
  }
  assert.equal(identify.find((m) => normalizeName(m.name) === 'ipad mini 4').year, 2015);
});

test('parseIdentifyPage throws on a page without models', () => {
  assert.throws(() => parseIdentifyPage('<html><h2 class="gb-header">iPad</h2><p>Year: 2020 A1234</p></html>'), /only 1 models/);
});

test('parseIdentifyPage throws when an A-number appears under two headings', () => {
  let html = '';
  for (let i = 0; i < 41; i++) html += `<h2 class="gb-header">iPad ${i}</h2><p>Year: 2020</p><p>Model number: A${1000 + i}</p>`;
  html += '<h2 class="gb-header">iPad dup</h2><p>Year: 2021</p><p>Model number: A1000</p>';
  assert.throws(() => parseIdentifyPage(`<div>${html}</div>`), /A1000 appears under/);
});

test('parseCompatPage 27: version from h1, topic ids, version list', () => {
  const c = compat[27];
  assert.equal(c.version, 27);
  const topic = (n) => c.models.find((m) => normalizeName(m.name) === normalizeName(n))?.topic_id;
  assert.equal(topic('iPad mini (A20 Pro)'), 'g0mrwneq8sk5');
  assert.match(topic('iPad Air 13-inch (M4)'), /^[a-z0-9]{8,}$/);
  assert.ok(!c.models.some((m) => normalizeName(m.name) === 'ipad'), 'no bare "iPad" entry');
  const vs = c.versions.map((v) => v.version);
  for (const v of [27, 26, 18, 17, 16, 15, 14, 13]) assert.ok(vs.includes(v), `versions has ${v}`);
  assert.match(c.versions.find((v) => v.version === 17).url, /\/17\.0\/ipados\//);
});

test('parseCompatPage 17 and 15 read their own versions', () => {
  assert.equal(compat[17].version, 17);
  assert.equal(compat[15].version, 15);
  assert.ok(compat[15].models.some((m) => normalizeName(m.name) === 'ipad mini 4'));
  assert.ok(!compat[17].models.some((m) => normalizeName(m.name) === 'ipad mini 4'));
});

test('parseCompatPage never takes the version from the URL and throws without one', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `<tr><td><a class="xRef" href="https://support.apple.com/guide/ipad/ipad-x-ipad${i}abc/27/ipados/27">iPad ${i}</a></td></tr>`).join('');
  const body = `<table aria-label="iPad models">${rows}</table>`;
  assert.throws(() => parseCompatPage(`<h1>iPad models</h1>${body}`), /no iPadOS version/);
  assert.throws(() => parseCompatPage('<h1>iPad models compatible with iPadOS 27</h1><table aria-label="iPad models"></table>'), /only 0 models/);
  assert.equal(parseCompatPage(`<h1>iPad models compatible with iPadOS 26</h1>${body}`).models[3].topic_id, 'ipad3abc');
});

test('parseCompatPage: iPadOS 13 guide (generic h1, /aside/ links)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `<tr><td><a class="xRef" href="https://support.apple.com/guide/ipad/aside/ipadb86e5a7${i}/13.0/ipados/13.0">iPad ${i}</a></td></tr>`).join('');
  const html = `<head><meta name="description" content="Find out which iPad models support iPadOS 13.6." /></head><h1>Supported iPad models</h1><table aria-label="iPad models">${rows}</table>`;
  const c = parseCompatPage(html);
  assert.equal(c.version, 13);
  assert.equal(c.models[0].topic_id, 'ipadb86e5a70');
  // the description fallback only applies to that generic heading
  assert.throws(() => parseCompatPage(html.replace('Supported iPad models', 'iPad models')), /no iPadOS version/);
});

test('diffCatalog: missing Air M4 -> one pending new_model per size', () => {
  const cat = catalogFrom(['iPad Air 11-inch (M4)', 'iPad Air 13-inch (M4)']);
  const before = JSON.stringify(cat);
  const { changes, catalog } = diffCatalog(cat, identify, allCompat);
  assert.equal(JSON.stringify(cat), before, 'input not mutated');
  const added = changes.filter((c) => c.kind === 'new_model');
  assert.deepEqual(added.map((c) => c.id).sort(), ['ipad-air-11-m4', 'ipad-air-13-m4']);
  for (const id of ['ipad-air-11-m4', 'ipad-air-13-m4']) {
    const m = byId(catalog, id);
    assert.equal(m.score_status, 'pending');
    assert.equal(m.score, null);
    assert.equal(m.family, 'air');
    assert.equal(m.chip, 'M4');
    assert.equal(m.max_os_major, 27);
    assert.equal(m.released, 2026);
    assert.ok(m.a_numbers.length >= 1);
    assert.ok(m.names.apple.length === 1);
    assert.match(m.apple_topic_id, /^[a-z0-9]+$/);
  }
  assert.equal(byId(catalog, 'ipad-air-11-m4').size_in, 11);
  assert.equal(byId(catalog, 'ipad-air-13-m4').size_in, 13);
  assert.deepEqual(validateCatalog(catalog, { previous: cat }), []);
});

test('diffCatalog: max OS per model from the highest page listing it', () => {
  const { catalog, changes } = diffCatalog(catalogFrom(), identify, allCompat);
  const os = (id) => byId(catalog, id).max_os_major;
  assert.equal(os('ipad-mini-4'), 15);
  assert.equal(os('ipad-air-2'), 15);
  assert.equal(os('ipad-pro-12-9'), 15); // only the 15 fixture is loaded, via topic id
  assert.equal(os('ipad-6th-generation'), 17);
  assert.equal(os('ipad-pro-10-5'), 17); // "iPad Pro (10.5-inch)" == "iPad Pro 10.5-inch" after normalizing
  assert.equal(os('ipad-8th-generation'), 26);
  assert.equal(os('ipad-pro-11'), 26); // via names.apple
  assert.equal(os('ipad-mini-5th-generation'), 26);
  assert.equal(os('ipad-pro-11-m4'), 27);
  assert.equal(os('ipad-mini-a20-pro'), 27);
  // too old for any guide: left alone, not an error
  assert.equal(os('ipad-2'), 9);
  assert.equal(os('ipad-original'), 9);
  assert.ok(changes.every((c) => c.kind === 'max_os_changed'));
  assert.ok(changes.length > 20);
});

test('diffCatalog: joins by topic id first, exact name second; never fuzzy', () => {
  const cat = catalogFrom();
  // renamed in the catalog, but the topic id still joins it
  const a20 = byId(cat, 'ipad-mini-a20-pro');
  a20.name = 'iPad mini 8';
  a20.apple_topic_id = 'g0mrwneq8sk5';
  a20.names.apple = ['iPad mini (A20 Pro)'];
  const { catalog } = diffCatalog(cat, identify, allCompat);
  assert.equal(byId(catalog, 'ipad-mini-a20-pro').max_os_major, 27);
  assert.equal(catalog.models.length, cat.models.length, 'no duplicate created for the renamed model');

  // a catalog model whose name only substring-matches Apple's is not joined
  const cat2 = catalogFrom(['iPad mini 4']);
  cat2.models.push(model('iPad mini 4 Wi-Fi', { released: 2015, max_os_major: 15 }));
  assert.throws(() => diffCatalog(cat2, identify, allCompat), /Not found on any compat page: ipad-mini-4-wi-fi$/);
});

test('diffCatalog: new A-numbers are added, none removed', () => {
  const cat = catalogFrom();
  const m = byId(cat, 'ipad-mini-4');
  const removed = m.a_numbers.pop();
  m.a_numbers.push('A9999');
  const { catalog, changes } = diffCatalog(cat, identify, allCompat);
  const c = changes.find((x) => x.kind === 'a_numbers_added');
  assert.deepEqual(c, { kind: 'a_numbers_added', id: 'ipad-mini-4', name: m.name, added: [removed] });
  assert.ok(byId(catalog, 'ipad-mini-4').a_numbers.includes('A9999'));
  assert.ok(byId(catalog, 'ipad-mini-4').a_numbers.includes(removed));
});

test('diffCatalog: latest_ipados rises, never falls', () => {
  const cat = catalogFrom();
  cat.latest_ipados = 26;
  const { changes, catalog } = diffCatalog(cat, identify, [compat[26], compat[17], compat[15]].concat([compat[27]]));
  assert.equal(catalog.latest_ipados, 27);
  assert.deepEqual(changes.find((c) => c.kind === 'latest_ipados_changed'), { kind: 'latest_ipados_changed', from: 26, to: 27 });
  assert.throws(() => diffCatalog(catalogFrom(), identify, [compat[26], compat[17], compat[15]]), /latest_ipados would decrease/);
});

test('diffCatalog: throws when a supported model is on no compat page', () => {
  const cat = catalogFrom();
  // without the 15 page, mini 4 (2015, iPadOS 15) is on no page
  assert.throws(() => diffCatalog(cat, identify, [compat[27], compat[26], compat[17]]), /Not found on any compat page: .*ipad-mini-4/);
});

test('summarize groups by kind, or says No changes', () => {
  assert.match(summarize([]), /No changes/);
  const { changes } = diffCatalog(catalogFrom(['iPad Air 11-inch (M4)']), identify, allCompat);
  const md = summarize(changes);
  assert.match(md, /## New models[\s\S]*iPad Air 11-inch \(M4\)/);
  assert.match(md, /## Max iPadOS changed[\s\S]*iPad mini 4 \(`ipad-mini-4`\): 13 → 15/);
  assert.ok(md.indexOf('## New models') < md.indexOf('## Max iPadOS changed'));
});

test('makeFetchApple spaces requests >= 10 s, retries 429/5xx with 30/60/120 s, sends the bot UA', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const statuses = [200, 429, 503, 200, 404];
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, ua: opts.headers['User-Agent'], t });
    const status = statuses.shift();
    return { ok: status === 200, status, text: async () => `body@${t}` };
  };
  const f = makeFetchApple({ fetch, sleep, now: () => t });
  await f('u1');
  await f('u2');
  assert.deepEqual(sleeps, [10000, 30000, 60000]);
  assert.ok(calls.every((c) => c.ua === USER_AGENT));
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].t - calls[i - 1].t >= 10000);
  await assert.rejects(f('u3'), /HTTP 404/);

  const always429 = makeFetchApple({ fetch: async () => ({ ok: false, status: 429 }), sleep: async () => {}, now: () => 0 });
  await assert.rejects(always429('x'), /HTTP 429/);
});

// ---- CLI run() ----

function stubFetch(pages) {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    const body = pages(url);
    return body === null ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => body };
  };
  return { fetch, urls };
}

function realPages(url) {
  if (url.includes('108043')) return identifyHtml;
  if (/\/ipados\/27$/.test(url) || /\/ipad213a25b2\/ipados$/.test(url)) return compatHtml[27];
  if (/\/26\/ipados\//.test(url)) return compatHtml[26];
  if (/\/17\.0\/ipados\//.test(url)) return compatHtml[17];
  if (/\/15\.0\/ipados\//.test(url)) return compatHtml[15];
  return null;
}

function tmpCatalog(cat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-apple-'));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(cat, null, 2) + '\n');
  return { dir, file };
}

test('parse failure writes nothing', async () => {
  const { dir, file } = tmpCatalog(catalogFrom());
  const before = fs.readFileSync(file);
  const { fetch } = stubFetch(() => '<html><body><h1>Identify your iPad model</h1><p>Nothing here</p></body></html>');
  const summaryPath = path.join(dir, 'summary.md');
  const { exitCode } = await run({ fetch, sleep: async () => {}, catalogPath: file, write: true, summaryPath, log: () => {}, error: () => {} });
  assert.equal(exitCode, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.ok(!fs.existsSync(summaryPath));
});

test('run: fetches identify + every listed version, writes a valid catalog and summary', async () => {
  const cat = catalogFrom(['iPad Air 11-inch (M4)']);
  const { dir, file } = tmpCatalog(cat);
  // 18/16/14/13 are "unavailable" in the stub: only the fixture versions are served
  const { fetch, urls } = stubFetch(realPages);
  const slept = [];
  const summaryPath = path.join(dir, 'summary.md');
  const res = await run({
    fetch, sleep: async (ms) => { slept.push(ms); }, catalogPath: file, write: true, summaryPath,
    versions: [27, 26, 17, 15], log: () => {}, error: () => {},
  });
  assert.equal(res.exitCode, 0);
  assert.ok(urls[0].includes('108043'));
  assert.equal(urls.length, 5);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(validateCatalog(written), []);
  assert.equal(byId(written, 'ipad-air-11-m4').score_status, 'pending');
  assert.equal(byId(written, 'ipad-mini-4').max_os_major, 15);
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /## New models/);
  assert.ok(res.changes.some((c) => c.kind === 'new_model'));
});

test('run without --write leaves the catalog alone; a fetched page with the wrong version fails', async () => {
  const { dir, file } = tmpCatalog(catalogFrom());
  const before = fs.readFileSync(file);
  const { fetch } = stubFetch(realPages);
  const res = await run({ fetch, sleep: async () => {}, catalogPath: file, write: false, versions: [27, 26, 17, 15], log: () => {}, error: () => {} });
  assert.equal(res.exitCode, 0);
  assert.deepEqual(fs.readFileSync(file), before);

  // Apple serves the latest guide for unknown versions: an 18 URL answered with the 27 page must fail
  const { fetch: f2 } = stubFetch((u) => (/\/18\.0\//.test(u) ? compatHtml[27] : realPages(u)));
  const res2 = await run({ fetch: f2, sleep: async () => {}, catalogPath: file, write: true, versions: [27, 26, 18, 17, 15], log: () => {}, error: () => {} });
  assert.equal(res2.exitCode, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  fs.rmSync(dir, { recursive: true });
});

test('makeFetchApple retries thrown fetch errors (network, timeout) with 30/60/120 s backoff', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  let n = 0;
  const fetch = async () => {
    n++;
    if (n <= 2) throw new TypeError('fetch failed');
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  const f = makeFetchApple({ fetch, sleep, now: () => t });
  assert.equal(await f('u'), 'ok');
  assert.deepEqual(sleeps, [30000, 60000]);

  const alwaysThrows = makeFetchApple({ fetch: async () => { throw new Error('boom'); }, sleep: async () => {}, now: () => 0 });
  await assert.rejects(alwaysThrows('x'), /boom/);
});

test('summarize lists new models with chip "unknown" under "Needs manual completion"', () => {
  const model = { a_numbers: ['A1'], max_os_major: 27, chip: 'unknown' };
  const known = { a_numbers: ['A2'], max_os_major: 27, chip: 'M4' };
  const md = summarize([
    { kind: 'new_model', id: 'a', name: 'iPad A', model },
    { kind: 'new_model', id: 'b', name: 'iPad B (M4)', model: known },
  ]);
  assert.match(md, /## Needs manual completion\n\n- iPad A \(`a`\)/);
  assert.doesNotMatch(md.split('## Needs manual completion')[1], /iPad B/);
  assert.doesNotMatch(summarize([{ kind: 'new_model', id: 'b', name: 'iPad B (M4)', model: known }]), /Needs manual completion/);
});
