#!/usr/bin/env node
'use strict';

// Compare public/catalog.json with Apple's identify page and iPadOS compatibility guides.
// Prints a markdown summary of proposed changes; --write applies them if the result validates.
// Usage: node scripts/check_apple.js [--write] [--summary out.md] [--catalog path]

const fs = require('node:fs');
const path = require('node:path');
const {
  IDENTIFY_URL, COMPAT_URL, makeFetchApple, parseIdentifyPage, parseCompatPage, diffCatalog, summarize,
} = require('./lib/apple');
const { validateCatalog } = require('./lib/validate');

const DEFAULT_CATALOG = path.join(__dirname, '..', 'public', 'catalog.json');

/**
 * @param {object} o
 * @param {Function} [o.fetch]   fetch-compatible function (injectable for tests)
 * @param {Function} [o.sleep]   ms -> Promise (injectable for tests)
 * @param {string}  o.catalogPath
 * @param {boolean} [o.write]    write the catalog when it validates
 * @param {string}  [o.summaryPath] write the markdown summary here on success
 * @param {number[]} [o.versions] restrict which listed iPadOS versions are fetched (tests)
 * @returns {Promise<{changes: object[], exitCode: number}>}
 */
async function run({ fetch = globalThis.fetch, sleep, catalogPath = DEFAULT_CATALOG, write = false, summaryPath = null, versions = null, log = console.log, error = console.error } = {}) {
  try {
    const previous = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const fetchApple = makeFetchApple({ fetch, ...(sleep ? { sleep } : {}) });

    const identify = parseIdentifyPage(await fetchApple(IDENTIFY_URL));
    const latest = parseCompatPage(await fetchApple(COMPAT_URL));
    const pages = [latest];
    const wanted = latest.versions
      .filter((v) => v.version !== latest.version)
      .filter((v) => !versions || versions.includes(v.version));
    for (const v of wanted) {
      const page = parseCompatPage(await fetchApple(v.url));
      if (page.version !== v.version) {
        throw new Error(`${v.url}: expected iPadOS ${v.version} guide, got iPadOS ${page.version}`);
      }
      pages.push(page);
    }

    const { changes, catalog } = diffCatalog(previous, identify, pages);
    const summary = summarize(changes);

    if (changes.length) {
      catalog.updated = new Date().toISOString().slice(0, 10);
      const errors = validateCatalog(catalog, { previous });
      if (errors.length) {
        error(`Catalog failed validation; nothing written:\n  ${errors.join('\n  ')}`);
        return { changes, exitCode: 1 };
      }
      if (write) fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    }
    if (summaryPath) fs.writeFileSync(summaryPath, summary);
    log(summary);
    return { changes, exitCode: 0 };
  } catch (e) {
    error(`check_apple: ${e.message}`);
    return { changes: [], exitCode: 1 };
  }
}

function parseArgs(argv) {
  const o = { write: false, summaryPath: null, catalogPath: DEFAULT_CATALOG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') o.write = true;
    else if (a === '--summary') o.summaryPath = path.resolve(argv[++i]);
    else if (a === '--catalog') o.catalogPath = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument ${a}. Usage: check_apple.js [--write] [--summary out.md] [--catalog path]`);
  }
  return o;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  run(opts).then(({ exitCode }) => process.exit(exitCode));
}

module.exports = { run };
