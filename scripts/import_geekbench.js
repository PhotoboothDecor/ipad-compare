#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseChart, applyChart } = require('./lib/geekbench');
const { validateCatalog } = require('./lib/validate');

const USER_AGENT = 'ipad-compare-bot (+https://github.com/PhotoboothDecor/ipad-compare)';
const DEFAULT_CATALOG = path.join(__dirname, '..', 'public', 'catalog.json');

function parseArgs(argv) {
  const o = { input: null, captured: null, dryRun: false, allowUnmatched: false, acceptLarge: false, catalog: DEFAULT_CATALOG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--allow-unmatched') o.allowUnmatched = true;
    else if (a === '--accept-large-changes') o.acceptLarge = true;
    else if (a === '--captured') o.captured = argv[++i];
    else if (a === '--catalog') o.catalog = path.resolve(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else if (o.input === null) o.input = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  if (!o.input) throw new Error('Usage: import_geekbench.js <file-or-wayback-url> [--captured YYYY-MM-DD] [--dry-run] [--catalog <path>] [--accept-large-changes] [--allow-unmatched]');
  if (o.captured !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.captured)) throw new Error('--captured must be YYYY-MM-DD');
  return o;
}

async function loadHtml(input) {
  if (!/^https?:\/\//i.test(input)) return fs.readFileSync(input, 'utf8');
  const url = new URL(input);
  if (url.hostname === 'browser.geekbench.com') {
    throw new Error('Refusing to fetch browser.geekbench.com (Cloudflare challenge). Use a saved HTML file or a web.archive.org capture.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'web.archive.org') {
    throw new Error('Only web.archive.org URLs or local files are allowed as input.');
  }
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const html = await loadHtml(opts.input);
  const chart = parseChart(html);

  let captured = opts.captured;
  if (!captured) {
    const w = /\/web\/(\d{4})(\d{2})(\d{2})/.exec(opts.input);
    captured = w ? `${w[1]}-${w[2]}-${w[3]}` : new Date().toISOString().slice(0, 10);
  }

  const previous = JSON.parse(fs.readFileSync(opts.catalog, 'utf8'));
  const { catalog, report } = applyChart(previous, chart, { captured });
  const unchanged = JSON.stringify(catalog) === JSON.stringify(previous);
  catalog.updated = new Date().toISOString().slice(0, 10);

  console.log(`Geekbench ${report.version} chart, captured ${captured}: ${chart.devices.length} iPads`);
  for (const c of report.changes) console.log(`  ${c.id}: gb6_multi ${c.before} -> ${c.after} (${c.source})`);
  for (const r of report.ratios) console.log(`  ratio ${r.chip} ${r.kind}: ${r.ratio.toFixed(4)} from ${r.basis.join(', ')} (spread ${r.spread.toFixed(3)})`);
  for (const c of report.chipFilled) console.log(`  ${c.id}: chip was "unknown"; set to ${c.chip} from the chart`);
  for (const w of report.warnings) console.log(`  warning: ${w}`);
  if (report.unmatched.length) {
    console.log('Unmatched chart devices (not added):');
    for (const d of report.unmatched) console.log(`  ${d.name} [${d.chip}] single ${d.single} multi ${d.multi}`);
  }

  const pending = catalog.models.filter((m) => m.score_status === 'pending');
  if (report.unmatched.length && pending.length && !opts.allowUnmatched) {
    console.error('Chart iPads with no matching catalog model:\n' + report.unmatched.map((d) => `  ${d.name}`).join('\n'));
    console.error('Models still pending (no score):\n' + pending.map((m) => `  ${m.name} (${m.id})`).join('\n'));
    console.error("Nothing written. If one of these is the same iPad, add the Geekbench name to that model's names.geekbench in public/catalog.json, then re-run (or use --allow-unmatched to import anyway).");
    process.exit(1);
  }

  const errors = validateCatalog(catalog, { previous });
  if (errors.length) {
    console.error('Validation failed:\n' + errors.map((e) => `  ${e}`).join('\n'));
    process.exit(1);
  }

  const large = report.changes.filter((c) => c.before != null && Math.abs(c.after - c.before) / c.before > 0.15);
  if (large.length && !opts.acceptLarge) {
    console.error('Score moves over 15% (use --accept-large-changes to allow):\n' +
      large.map((c) => `  ${c.id}: ${c.before} -> ${c.after}`).join('\n'));
    process.exit(1);
  }

  if (unchanged) {
    console.log('No score changes');
    return;
  }

  if (opts.dryRun) {
    console.log('Dry run: nothing written.');
    return;
  }
  fs.writeFileSync(opts.catalog, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Wrote ${opts.catalog}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
