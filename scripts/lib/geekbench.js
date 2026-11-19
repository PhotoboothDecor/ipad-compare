'use strict';

const cheerio = require('cheerio');
const { normalizeName } = require('./names');

const MIN_IPADS = 20;

// Parse a saved Geekbench iOS benchmark chart. Input is untrusted HTML: parse only.
function parseChart(html) {
  const $ = cheerio.load(html);

  let version = null;
  $('p').each((_, el) => {
    const m = /Geekbench (\d+)/.exec($(el).text());
    if (m && version === null) version = Number(m[1]);
  });
  if (version === null) throw new Error('Could not determine Geekbench version from chart text');
  if (version !== 6 && version !== 7) throw new Error(`Unsupported Geekbench version ${version}`);

  // Rows are keyed by device page slug: some iPads have 9-core and 10-core
  // variants listed under one display name.
  const read = (tab) => {
    const out = new Map();
    $(`#${tab} tr`).each((_, tr) => {
      const a = $(tr).find('td.name a').first();
      const name = a.text().replace(/\s+/g, ' ').trim();
      if (!/^iPad/.test(name)) return;
      const key = (a.attr('href') || name).replace(/^.*\/ios_devices\//, '');
      const chip = $(tr).find('td.name .description').first().text().replace(/\s+/g, ' ').trim();
      const score = parseInt($(tr).find('td.score').first().text().trim(), 10);
      if (!Number.isFinite(score)) throw new Error(`Bad score for "${name}" in ${tab}`);
      if (out.has(key)) throw new Error(`Duplicate device page "${key}" in ${tab}`);
      out.set(key, { name, chip, score });
    });
    return out;
  };

  const single = read('single-core');
  const multi = read('multi-core');
  // One entry per display name. Where variants share a name, keep the one with
  // the lowest multi-core score (the base configuration the catalog models).
  const byName = new Map();
  for (const [key, m] of multi) {
    const s = single.get(key);
    if (!s) throw new Error(`"${m.name}" missing from single-core tab`);
    const cur = byName.get(m.name);
    if (!cur || m.score < cur.multi) byName.set(m.name, { name: m.name, chip: m.chip, single: s.score, multi: m.score });
  }
  const devices = [...byName.values()];
  if (devices.length < MIN_IPADS) {
    throw new Error(`Only ${devices.length} iPads found (expected at least ${MIN_IPADS}); chart layout may have changed`);
  }
  return { version, devices };
}

function chipClass(chip) {
  if (/^M\d/.test(chip)) return 'M';
  if (/^A\d+[XZ]$/.test(chip)) return 'AX';
  return 'A';
}

const shortChip = (c) => String(c).replace(/^Apple\s+/, '').replace(/\s+Bionic$/, '').trim();
const chipNum = (c) => {
  const m = /\d+/.exec(c);
  return m ? Number(m[0]) : -1;
};

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const scoreKeys = (kind) => (kind === 'single' ? ['gb6_single', 'gb7_single'] : ['gb6_multi', 'gb7_multi']);

function conversionRatio(chip, pairs, kind) {
  const [k6, k7] = scoreKeys(kind);
  const usable = pairs.filter((m) => m.score && m.score[k6] > 0 && m.score[k7] > 0);
  let chosen = usable.filter((m) => m.chip === chip);
  if (chosen.length === 0) {
    const cls = chipClass(chip);
    const sameClass = usable.filter((m) => chipClass(m.chip) === cls);
    const top = [...new Set(sameClass.map((m) => m.chip))]
      .sort((a, b) => chipNum(b) - chipNum(a) || a.localeCompare(b))
      .slice(0, 2);
    chosen = sameClass.filter((m) => top.includes(m.chip));
  }
  if (chosen.length === 0) throw new Error(`No GB6/GB7 pairs available to convert ${chip} (${kind})`);
  const ratios = chosen.map((m) => m.score[k7] / m.score[k6]);
  const med = median(ratios);
  const spread = (Math.max(...ratios) - Math.min(...ratios)) / med;
  if (spread > 0.10) {
    throw new Error(`Conversion ratio spread ${spread.toFixed(3)} > 0.10 for ${chip} (${kind}) from ${chosen.map((m) => m.name).join(', ')}`);
  }
  return { ratio: med, basis: chosen.map((m) => m.name), spread };
}

// Pure: returns a new catalog plus a report. Ratios come from the catalog as it
// was before this chart, so a new GB7 chart never shifts its own conversions.
function applyChart(catalog, chart, { captured }) {
  const next = JSON.parse(JSON.stringify(catalog));
  const report = { version: chart.version, changes: [], unmatched: [], ratios: [], warnings: [], chipFilled: [] };

  // Exact normalized equality over name, names.geekbench and names.aliases.
  const index = new Map();
  for (const m of next.models) {
    for (const n of [m.name, ...m.names.geekbench, ...m.names.aliases]) {
      const key = normalizeName(n);
      const other = index.get(key);
      if (other && other !== m) throw new Error(`Name "${n}" matches both ${other.id} and ${m.id}`);
      index.set(key, m);
    }
  }

  const pairs = catalog.models.filter((m) => m.score && m.score.source === 'gb6' && m.score.gb7_multi != null && m.score.gb7_single != null);
  const ratioCache = new Map();
  const ratioFor = (chip, kind) => {
    const key = `${chip}|${kind}`;
    if (!ratioCache.has(key)) {
      const r = conversionRatio(chip, pairs, kind);
      ratioCache.set(key, r);
      report.ratios.push({ chip, kind, ratio: r.ratio, basis: r.basis, spread: r.spread });
    }
    return ratioCache.get(key);
  };

  for (const d of chart.devices) {
    const m = index.get(normalizeName(d.name));
    if (!m) {
      report.unmatched.push(d);
      continue;
    }
    if (m.score_status === 'unsupported') {
      report.warnings.push(`${m.id}: marked unsupported but appears in chart; skipped`);
      continue;
    }
    if (m.chip === 'unknown' && shortChip(d.chip)) {
      m.chip = shortChip(d.chip);
      report.chipFilled.push({ id: m.id, chip: m.chip });
    }
    if (shortChip(d.chip) !== m.chip) {
      report.warnings.push(`${m.id}: chart chip "${d.chip}" differs from catalog chip "${m.chip}"`);
    }
    const before = m.score ? m.score.gb6_multi : null;
    const old = m.score;

    if (chart.version === 6) {
      m.score = {
        gb6_multi: d.multi,
        gb6_single: d.single,
        source: 'gb6',
        gb7_multi: old ? old.gb7_multi : null,
        gb7_single: old ? old.gb7_single : null,
        ratio_multi: null,
        ratio_single: null,
        captured,
      };
      m.score_status = 'ok';
    } else if (old && old.source === 'gb6') {
      old.gb7_multi = d.multi;
      old.gb7_single = d.single;
    } else {
      const rm = ratioFor(m.chip, 'multi');
      const rs = ratioFor(m.chip, 'single');
      m.score = {
        gb6_multi: Math.round(d.multi / rm.ratio),
        gb6_single: Math.round(d.single / rs.ratio),
        source: 'gb7-converted',
        gb7_multi: d.multi,
        gb7_single: d.single,
        ratio_multi: Number(rm.ratio.toFixed(4)),
        ratio_single: Number(rs.ratio.toFixed(4)),
        captured,
      };
      m.score_status = 'ok';
    }
    report.changes.push({ id: m.id, name: m.name, before, after: m.score.gb6_multi, source: m.score.source });
  }

  return { catalog: next, report };
}

module.exports = { parseChart, chipClass, conversionRatio, applyChart };
