#!/usr/bin/env node
'use strict';

// One-off migration: build public/catalog.json from the sources.
//   Apple identify page (names, A-numbers, year) + iPadOS compatibility guides (max OS, topic ids)
//   AppleDB (chip, cross-check of A-numbers)
//   git 50ce8dc:public/model_mapping.json (pre-corruption A-numbers + aliases)
//   Geekbench 6 chart 2026-07-18, then Geekbench 7 chart 2026-11-19 (scores)
// Usage: node scripts/migrate/build_catalog.js [--from-fixtures] [--out path] [--review path]
//   --from-fixtures  read the identify page and every apple-compat-*.html from scripts/test/fixtures
//                    instead of fetching support.apple.com.
// Prints every problem it finds and exits 1 without writing anything if any remain.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeName, slugify } = require('../lib/names');
const { IDENTIFY_URL, COMPAT_URL, makeFetchApple, parseIdentifyPage, parseCompatPage } = require('../lib/apple');
const { parseChart, applyChart } = require('../lib/geekbench');
const { validateCatalog } = require('../lib/validate');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const APPLEDB_URL = 'https://api.appledb.dev/device/main.json';
const USER_AGENT = 'ipad-compare-bot (+https://github.com/PhotoboothDecor/ipad-compare)';
const OLD_MAPPING_REF = '50ce8dc:public/model_mapping.json';
const CHARTS = [
  { file: path.join(FIXTURES, 'gb6-2026-07-18.html'), captured: '2026-07-18', version: 6 },
  { file: path.join(FIXTURES, 'gb7-2026-11-19.html'), captured: '2026-11-19', version: 7 },
];

// Pre-iPadOS-13 devices: last iOS major. These are also the models too old for Geekbench 6.
const PRE13_MAX_OS = {
  'iPad': 5,
  'iPad 2': 9,
  'iPad (3rd generation)': 9,
  'iPad (4th generation)': 10,
  'iPad mini': 9,
  'iPad Air': 12,
  'iPad mini 2': 12,
  'iPad mini 3': 12,
};

// Per-model fixes Apple's pages need (see scripts/test/apple.test.js CATALOG_EXTRAS).
const ID_OVERRIDES = { 'iPad': 'ipad-original' }; // slugify gives "ipad", which the id pattern rejects
const APPLE_NAME_EXTRAS = { 'iPad Pro 11-inch': ['iPad Pro 11-inch (1st generation)'] };
// The iPadOS 15 guide lists the 1st and 2nd gen 12.9" Pro under one topic; 2nd gen has its own on later guides.
const TOPIC_OVERRIDES = { 'iPad Pro (12.9-inch)': 'ipad0012b470' };

// Geekbench device name -> Apple name, where they differ by more than punctuation.
const GB_TO_APPLE = {
  'iPad Air 11-inch (7th generation)': 'iPad Air 11-inch (M3)',
  'iPad Air 13-inch (7th generation)': 'iPad Air 13-inch (M3)',
  'iPad (11th generation)': 'iPad (A16)',
  'iPad mini (7th generation)': 'iPad mini (A17 Pro)',
  'iPad Pro (11-inch)': 'iPad Pro 11-inch',
  'iPad Pro (11-inch, 4th generation)': 'iPad Pro 11-inch (4th generation)',
  'iPad Pro (12.9-inch, 6th generation)': 'iPad Pro 12.9-inch (6th generation)',
};

// Apple's generation number within a line. Pro generations count per screen-size line
// (12.9"/13" and 11"); the one-off 9.7" and 10.5" Pros have none.
const GENERATION = {
  'iPad': 1, 'iPad 2': 2, 'iPad (3rd generation)': 3, 'iPad (4th generation)': 4, 'iPad (5th generation)': 5,
  'iPad (6th generation)': 6, 'iPad (7th generation)': 7, 'iPad (8th generation)': 8, 'iPad (9th generation)': 9,
  'iPad (10th generation)': 10, 'iPad (A16)': 11,
  'iPad mini': 1, 'iPad mini 2': 2, 'iPad mini 3': 3, 'iPad mini 4': 4, 'iPad mini (5th generation)': 5,
  'iPad mini (6th generation)': 6, 'iPad mini (A17 Pro)': 7, 'iPad mini (A20 Pro)': 8,
  'iPad Air': 1, 'iPad Air 2': 2, 'iPad Air (3rd generation)': 3, 'iPad Air (4th generation)': 4,
  'iPad Air (5th generation)': 5, 'iPad Air 11-inch (M2)': 6, 'iPad Air 13-inch (M2)': 6,
  'iPad Air 11-inch (M3)': 7, 'iPad Air 13-inch (M3)': 7, 'iPad Air 11-inch (M4)': 8, 'iPad Air 13-inch (M4)': 8,
  'iPad Pro (12.9-inch)': 1, 'iPad Pro 12.9-inch (2nd generation)': 2, 'iPad Pro 12.9-inch (3rd generation)': 3,
  'iPad Pro 12.9-inch (4th generation)': 4, 'iPad Pro 12.9-inch (5th generation)': 5,
  'iPad Pro 12.9-inch (6th generation)': 6, 'iPad Pro 13-inch (M4)': 7, 'iPad Pro 13-inch (M5)': 8,
  'iPad Pro 11-inch': 1, 'iPad Pro 11-inch (2nd generation)': 2, 'iPad Pro 11-inch (3rd generation)': 3,
  'iPad Pro 11-inch (4th generation)': 4, 'iPad Pro 11-inch (M4)': 5, 'iPad Pro 11-inch (M5)': 6,
  'iPad Pro (9.7-inch)': null, 'iPad Pro (10.5-inch)': null,
};

// Hand-written aliases: common ways listings name a model that the generated forms miss.
const EXTRA_ALIASES = {
  'iPad': ['iPad 1', 'iPad (1st generation)', 'iPad 1st generation', 'iPad original'],
  'iPad (3rd generation)': ['iPad 3'],
  'iPad (4th generation)': ['iPad 4'],
  'iPad mini': ['iPad mini 1', 'iPad mini (1st generation)'],
  'iPad Air': ['iPad Air 1', 'iPad Air (1st generation)'],
  'iPad Pro (12.9-inch)': ['iPad Pro 12.9-inch (1st generation)', 'iPad Pro 12.9 (1st generation)'],
  'iPad Pro (9.7-inch)': ['iPad Pro 9.7'],
  'iPad Pro (10.5-inch)': ['iPad Pro 10.5'],
};

// Old-mapping aliases dropped on purpose although they are unique strings.
const DROP_OLD_ALIASES = new Set([
  'iPad Pro 2', 'iPad Pro 2nd Gen', // also describe the 12.9-inch (2nd generation)
  'iPad Air (6th generation)', '6th generation Air', // generation shared by both M2 Airs -> `generation` field
  'iPad Air (7th generation)', '7th generation Air', // generation shared by both M3 Airs
].map(normalizeName));

const ord = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${s}`;
};
const punctKey = (s) => normalizeName(s).replace(/[^a-z0-9]/g, '');

const problems = [];
const problem = (msg) => { problems.push(msg); console.error(`PROBLEM: ${msg}`); };

function parseArgs(argv) {
  const o = { fromFixtures: false, out: path.join(ROOT, 'public', 'catalog.json'), review: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-fixtures') o.fromFixtures = true;
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--review') o.review = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument ${a}. Usage: build_catalog.js [--from-fixtures] [--out path] [--review path]`);
  }
  return o;
}

async function loadApple(fromFixtures) {
  if (fromFixtures) {
    const identify = parseIdentifyPage(fs.readFileSync(path.join(FIXTURES, 'apple-identify-108043.html'), 'utf8'));
    const pages = fs.readdirSync(FIXTURES)
      .filter((f) => /^apple-compat-\d+\.html$/.test(f))
      .map((f) => parseCompatPage(fs.readFileSync(path.join(FIXTURES, f), 'utf8')));
    return { identify, pages };
  }
  const fetchApple = makeFetchApple();
  const identify = parseIdentifyPage(await fetchApple(IDENTIFY_URL));
  const latest = parseCompatPage(await fetchApple(COMPAT_URL));
  const pages = [latest];
  for (const v of latest.versions.filter((x) => x.version !== latest.version)) {
    const p = parseCompatPage(await fetchApple(v.url));
    if (p.version !== v.version) throw new Error(`${v.url}: expected iPadOS ${v.version}, got ${p.version}`);
    pages.push(p);
  }
  return { identify, pages };
}

async function loadAppleDb() {
  const res = await fetch(APPLEDB_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`GET ${APPLEDB_URL}: HTTP ${res.status}`);
  const all = await res.json();
  return all.filter((d) => /^iPad/.test(d.type || '') && Array.isArray(d.model) && d.model.length);
}

function loadOldMapping() {
  return JSON.parse(execFileSync('git', ['show', OLD_MAPPING_REF], { cwd: ROOT, encoding: 'utf8' }));
}

function baseModel(im) {
  const n = normalizeName(im.name);
  const family = /^ipad pro\b/.test(n) ? 'pro' : /^ipad air\b/.test(n) ? 'air' : /^ipad mini\b/.test(n) ? 'mini' : 'ipad';
  const size = /(\d+(?:\.\d+)?)-inch/.exec(n);
  if (!(im.name in GENERATION)) problem(`no generation entry for "${im.name}"`);
  return {
    id: ID_OVERRIDES[im.name] || slugify(im.name),
    name: im.name,
    family,
    size_in: size ? Number(size[1]) : null,
    chip: null,
    released: im.year,
    generation: GENERATION[im.name] ?? null,
    a_numbers: [...im.a_numbers],
    max_os_major: null,
    apple_topic_id: TOPIC_OVERRIDES[im.name] || null,
    names: { apple: [im.name, ...(APPLE_NAME_EXTRAS[im.name] || [])], geekbench: [], aliases: [] },
    score_status: 'pending',
    score: null,
  };
}

// Chip and A-number cross-check against AppleDB. Joins by A-number equality only.
function applyAppleDb(models, adb, oldExtras) {
  const byA = new Map();
  for (const m of models) for (const a of [...m.a_numbers, ...(oldExtras.get(m) || [])]) byA.set(a, m);
  const perModel = new Map(models.map((m) => [m, { socs: new Set(), ids: new Set(), as: new Set(), years: new Set() }]));
  for (const d of adb) {
    const owners = new Set(d.model.map((a) => byA.get(a)).filter(Boolean));
    if (owners.size === 0) { problem(`AppleDB ${d.identifier} "${d.name}" (${d.model.join(',')}) matches no identify-page model`); continue; }
    if (owners.size > 1) { problem(`AppleDB ${d.identifier} "${d.name}" spans ${[...owners].map((m) => m.name).join(' / ')}`); continue; }
    const s = perModel.get([...owners][0]);
    s.socs.add(d.soc);
    for (const i of d.identifier || []) s.ids.add(i);
    for (const a of d.model) s.as.add(a);
    for (const r of [].concat(d.released || [])) s.years.add(Number(String(r).slice(0, 4)));
  }
  const idOwner = new Map();
  for (const m of models) {
    const s = perModel.get(m);
    if (s.socs.size !== 1) { problem(`${m.name}: AppleDB chips ${JSON.stringify([...s.socs])}`); continue; }
    m.chip = [...s.socs][0];
    const named = /\(([AM]\d+[A-Z]?(?: Pro)?)\)/.exec(m.name);
    if (named && named[1] !== m.chip) problem(`${m.name}: name says ${named[1]}, AppleDB says ${m.chip}`);
    for (const i of s.ids) {
      if (idOwner.has(i)) problem(`${i} maps to both ${idOwner.get(i)} and ${m.name}`);
      idOwner.set(i, m.name);
    }
    m._identifiers = [...s.ids].sort();
    // A-numbers: Apple's, plus 50ce8dc's when AppleDB confirms them for this model.
    for (const a of oldExtras.get(m) || []) {
      if (m.a_numbers.includes(a)) continue;
      if (s.as.has(a)) { m.a_numbers.push(a); console.log(`  + ${m.name}: ${a} (50ce8dc, confirmed by AppleDB)`); }
      else console.log(`  - ${m.name}: ${a} from 50ce8dc not confirmed by AppleDB; dropped`);
    }
    const missing = [...s.as].filter((a) => !m.a_numbers.includes(a));
    if (missing.length) problem(`${m.name}: AppleDB lists ${missing.join(', ')}, which neither Apple nor 50ce8dc has`);
    const notInDb = m.a_numbers.filter((a) => !s.as.has(a));
    if (notInDb.length) problem(`${m.name}: ${notInDb.join(', ')} not in AppleDB`);
    if (s.years.size && !s.years.has(m.released) && Math.min(...s.years) !== m.released) {
      console.log(`  note: ${m.name}: Apple year ${m.released}, AppleDB ${[...s.years].join('/')}`);
    }
    m.a_numbers.sort();
  }
}

// Map each 50ce8dc entry to a model: A-number equality, else exact normalized name (Apple or GB table).
function mapOldEntries(models, old) {
  const byA = new Map();
  const byName = new Map();
  for (const m of models) {
    for (const a of m.a_numbers) byA.set(a, m);
    for (const n of m.names.apple) byName.set(normalizeName(n), m);
  }
  for (const [gb, apple] of Object.entries(GB_TO_APPLE)) {
    const m = byName.get(normalizeName(apple));
    if (m) byName.set(normalizeName(gb), m);
  }
  const out = new Map();
  for (const e of old) {
    const owners = new Set(e.model_numbers.map((a) => byA.get(a)).filter(Boolean));
    let m = owners.size === 1 ? [...owners][0] : null;
    if (owners.size > 1) problem(`50ce8dc "${e.model_name}" A-numbers span ${[...owners].map((x) => x.name).join(' / ')}`);
    if (!m && owners.size === 0) m = byName.get(normalizeName(e.model_name)) || null;
    if (!m) { problem(`50ce8dc "${e.model_name}" matches no model`); continue; }
    if (normalizeName(e.model_name) !== normalizeName(m.name) && !byName.has(normalizeName(e.model_name))) {
      console.log(`  50ce8dc "${e.model_name}" -> ${m.name} (by A-number)`);
    }
    out.set(m, { extrasA: e.model_numbers.filter((a) => /^A\d{4}$/.test(a)), name: e.model_name, aliases: e.aliases || [] });
  }
  return out;
}

function seedGeekbenchNames(models, charts) {
  const byName = new Map();
  const byPunct = new Map();
  for (const m of models) {
    for (const n of m.names.apple) {
      byName.set(normalizeName(n), m);
      const k = punctKey(n);
      byPunct.set(k, byPunct.has(k) && byPunct.get(k) !== m ? 'AMBIGUOUS' : m);
    }
  }
  const unplaced = [];
  for (const chart of charts) {
    for (const d of chart.devices) {
      let m = byName.get(normalizeName(d.name));
      if (!m && GB_TO_APPLE[d.name]) m = byName.get(normalizeName(GB_TO_APPLE[d.name]));
      if (!m) {
        const p = byPunct.get(punctKey(d.name));
        if (p && p !== 'AMBIGUOUS') m = p;
      }
      if (!m) { unplaced.push(d.name); continue; }
      if (normalizeName(d.name) !== normalizeName(m.name) && !m.names.geekbench.includes(d.name)) m.names.geekbench.push(d.name);
    }
  }
  for (const n of [...new Set(unplaced)]) problem(`Geekbench name not placed: "${n}"`);
}

// Generated generation aliases; collisions across models are removed below.
function generatedAliases(m) {
  const g = m.generation;
  if (!g) return [];
  const o = ord(g);
  const out = [];
  const add = (base) => out.push(`${base} ${o} generation`, `${base} ${o} gen`, `${base} (${o} generation)`);
  if (m.family === 'pro') {
    const sizes = m.size_in === 13 ? ['13-inch', '13'] : m.size_in === 12.9 ? ['12.9-inch', '12.9'] : m.size_in === 11 ? ['11-inch', '11'] : [];
    for (const s of sizes) add(`iPad Pro ${s}`);
    const chip = /^M\d/.test(m.chip) ? m.chip : null;
    if (chip) for (const s of sizes) out.push(`iPad Pro ${s} ${chip}`, `iPad Pro ${chip} ${s}`);
    return out;
  }
  const base = { ipad: 'iPad', air: 'iPad Air', mini: 'iPad mini' }[m.family];
  add(base);
  out.push(`${base} ${g}`);
  if (m.size_in) {
    for (const s of [`${m.size_in}-inch`, `${m.size_in}`]) {
      add(`${base} ${s}`);
      if (/^M\d/.test(m.chip)) out.push(`${base} ${s} ${m.chip}`, `${base} ${m.chip} ${s}`);
    }
  }
  if (m.family === 'mini' || m.family === 'ipad') {
    if (/[A-Z]/.test(m.chip) && m.released >= 2024) out.push(`${base} ${m.chip}`);
  }
  return out;
}

function buildAliases(models, oldByModel) {
  const cand = new Map(); // model -> [alias]
  for (const m of models) {
    const list = [...generatedAliases(m), ...(EXTRA_ALIASES[m.name] || [])];
    const old = oldByModel.get(m);
    if (old) {
      list.push(old.name);
      for (const a of old.aliases) {
        const n = normalizeName(a);
        if (DROP_OLD_ALIASES.has(n)) { console.log(`  alias dropped (shared/ambiguous): ${m.name}: "${a}"`); continue; }
        if (!/\bipad\b|^(air|mini) /.test(n)) { console.log(`  alias dropped (fragment): ${m.name}: "${a}"`); continue; }
        list.push(a);
      }
    }
    cand.set(m, list);
  }
  // Owner count per normalized string, over names, Apple names, GB names and all candidates.
  const owners = new Map();
  const own = (n, m) => { if (!owners.has(n)) owners.set(n, new Set()); owners.get(n).add(m); };
  for (const m of models) {
    for (const n of [m.name, ...m.names.apple, ...m.names.geekbench]) own(normalizeName(n), m);
    for (const a of cand.get(m)) own(normalizeName(a), m);
  }
  const dropped = new Set();
  for (const m of models) {
    const fixed = new Set([m.name, ...m.names.apple, ...m.names.geekbench].map(normalizeName));
    const seen = new Set(fixed);
    for (const a of cand.get(m)) {
      const n = normalizeName(a);
      if (seen.has(n)) continue;
      seen.add(n);
      if (owners.get(n).size > 1) { dropped.add(`"${n}" (${[...owners.get(n)].map((x) => x.id).join(', ')})`); continue; }
      m.names.aliases.push(a);
    }
  }
  for (const d of [...dropped].sort()) console.log(`  alias dropped (not unique): ${d}`);
}

function setMaxOs(models, pages) {
  const versionsDesc = [...new Set(pages.flatMap((p) => p.versions.map((v) => v.version)).concat(pages.map((p) => p.version)))].sort((a, b) => b - a);
  const loaded = new Set(pages.map((p) => p.version));
  const latest = Math.max(...loaded);
  const maxByTopic = new Map();
  const maxByName = new Map();
  const topicByName = new Map();
  for (const p of [...pages].sort((a, b) => b.version - a.version)) {
    for (const e of p.models) {
      const n = normalizeName(e.name);
      if (!maxByTopic.has(e.topic_id)) maxByTopic.set(e.topic_id, p.version);
      if (!maxByName.has(n)) { maxByName.set(n, p.version); topicByName.set(n, e.topic_id); }
    }
  }
  const unresolved = [];
  for (const m of models) {
    if (!m.apple_topic_id) {
      for (const n of m.names.apple) if (topicByName.has(normalizeName(n))) { m.apple_topic_id = topicByName.get(normalizeName(n)); break; }
    }
    let v = m.apple_topic_id ? maxByTopic.get(m.apple_topic_id) : undefined;
    for (const n of m.names.apple) {
      const x = maxByName.get(normalizeName(n));
      if (x !== undefined && (v === undefined || x > v)) v = x;
    }
    if (m.name in PRE13_MAX_OS) {
      if (v !== undefined) problem(`${m.name}: hardcoded pre-13 but listed on the iPadOS ${v} guide`);
      m.max_os_major = PRE13_MAX_OS[m.name];
      continue;
    }
    if (v === undefined) { unresolved.push(`${m.name}: on no compatibility guide and not in the pre-13 table`); continue; }
    // v is the highest guide listing the model. It is the max only if the next listed version is loaded.
    const next = versionsDesc.filter((x) => x > v).pop();
    if (v !== latest && !loaded.has(next)) {
      const nextLoaded = Math.min(...[...loaded].filter((x) => x > v));
      const upper = versionsDesc.filter((x) => x < nextLoaded)[0];
      unresolved.push(`${m.name}: last listed on the iPadOS ${v} guide; iPadOS ${next} guide not loaded, so max is ${v}..${upper}`);
      m.max_os_major = v;
      continue;
    }
    m.max_os_major = v;
  }
  for (const u of unresolved) problem(`max OS unresolved: ${u}`);
  return { latest, loaded: [...loaded].sort((a, b) => b - a), all: versionsDesc };
}

function applyScores(catalog) {
  for (const m of catalog.models) if (m.name in PRE13_MAX_OS) m.score_status = 'unsupported';
  let cat = catalog;
  const charts = [];
  for (const c of CHARTS) {
    const chart = parseChart(fs.readFileSync(c.file, 'utf8'));
    if (chart.version !== c.version) throw new Error(`${c.file}: expected Geekbench ${c.version}, got ${chart.version}`);
    if (chart.version === 7) {
      // Ratios come from the catalog as it was before the chart, so first record GB7 numbers for
      // models that already have a GB6 score, then apply the whole chart (which converts the rest).
      const scored = new Set(cat.models.filter((m) => m.score).flatMap((m) => [m.name, ...m.names.geekbench].map(normalizeName)));
      const pairsOnly = { ...chart, devices: chart.devices.filter((d) => scored.has(normalizeName(d.name))) };
      cat = applyChart(cat, pairsOnly, { captured: c.captured }).catalog;
    }
    const { catalog: next, report } = applyChart(cat, chart, { captured: c.captured });
    console.log(`Geekbench ${chart.version} (${c.captured}): ${chart.devices.length} iPads, ${report.changes.length} applied`);
    for (const u of report.unmatched) problem(`GB${chart.version} device not matched: "${u.name}"`);
    for (const w of report.warnings) console.log(`  warning: ${w}`);
    for (const r of report.ratios) console.log(`  ratio ${r.chip} ${r.kind}: ${r.ratio.toFixed(4)} from ${r.basis.join(', ')} (spread ${r.spread.toFixed(3)})`);
    cat = next;
    charts.push(chart);
  }
  return cat;
}

function reviewTable(catalog) {
  const rows = catalog.models.map((m) => {
    const s = m.score;
    const score = s ? String(s.gb6_multi) : '—';
    const source = s ? (s.source === 'gb6' ? `gb6 ${s.captured}` : `gb7-converted ${s.captured} (÷${s.ratio_multi})`) : m.score_status;
    return `| ${m.name} | ${m.chip} | ${m.released} | ${m.max_os_major} | ${score} | ${source} | ${m.a_numbers.length} |`;
  });
  return ['| Name | Chip | Year | Max OS | GB6 multi | Source / status | A-numbers |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { identify, pages } = await loadApple(opts.fromFixtures);
  console.log(`Apple: ${identify.length} models on the identify page; guides loaded: iPadOS ${pages.map((p) => p.version).sort((a, b) => b - a).join(', ')}${opts.fromFixtures ? ' (fixtures)' : ''}`);
  const adb = await loadAppleDb();
  console.log(`AppleDB: ${adb.length} iPad variants with model numbers`);
  const old = loadOldMapping();

  const models = identify.map(baseModel);
  const oldByModel = mapOldEntries(models, old);
  applyAppleDb(models, adb, new Map([...oldByModel].map(([m, e]) => [m, e.extrasA])));
  const os = setMaxOs(models, pages);

  const charts = CHARTS.map((c) => parseChart(fs.readFileSync(c.file, 'utf8')));
  seedGeekbenchNames(models, charts);
  buildAliases(models, oldByModel);

  const ordered = models.map(({ _identifiers, ...m }) => m);
  let catalog = { schema_version: 1, updated: new Date().toISOString().slice(0, 10), latest_ipados: os.latest, models: ordered };
  catalog = applyScores(catalog);

  const by = (st) => catalog.models.filter((m) => m.score_status === st);
  const converted = catalog.models.filter((m) => m.score && m.score.source === 'gb7-converted');
  console.log(`\nmodels: ${catalog.models.length}`);
  console.log(`ok: ${by('ok').length} (gb6 ${by('ok').length - converted.length}, gb7-converted ${converted.length})`);
  console.log(`converted: ${converted.map((m) => `${m.name} = ${m.score.gb6_multi}`).join('; ') || 'none'}`);
  console.log(`pending: ${by('pending').map((m) => m.name).join('; ') || 'none'}`);
  console.log(`unsupported: ${by('unsupported').length} (${by('unsupported').map((m) => m.name).join('; ')})`);
  console.log(`aliases: ${catalog.models.reduce((n, m) => n + m.names.aliases.length, 0)}; A-numbers: ${catalog.models.reduce((n, m) => n + m.a_numbers.length, 0)}`);

  const expectPending = ['iPad Air 11-inch (M4)', 'iPad Air 13-inch (M4)'];
  if (JSON.stringify(by('pending').map((m) => m.name).sort()) !== JSON.stringify(expectPending.sort())) problem('pending models are not exactly the two M4 Airs');
  if (converted.length !== 1 || converted[0].name !== 'iPad mini (A20 Pro)') problem('converted models are not exactly iPad mini (A20 Pro)');

  const errors = validateCatalog(catalog);
  for (const e of errors) problem(`validation: ${e}`);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s); nothing written.`);
    process.exit(1);
  }
  fs.writeFileSync(opts.out, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(process.cwd(), opts.out)}`);
  if (opts.review) {
    fs.writeFileSync(opts.review, reviewTable(catalog) + '\n');
    console.log(`wrote ${path.relative(process.cwd(), opts.review)}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`build_catalog: ${e.stack || e.message}`);
    process.exit(1);
  });
}
