#!/usr/bin/env node
// Headless smoke test of the static site in public/.
//
//   node scripts/smoke/smoke.mjs
//
// Serves public/ on a local port, drives it with Playwright (Chromium, headless,
// no screenshots) and exits 1 on the first failed check. Playwright is not a
// project dependency: if `import('playwright')` fails, the script fetches it
// with `npx --yes -p playwright@<PLAYWRIGHT_VERSION>` and loads it from there.
// External requests (Google Fonts) are answered locally with empty bodies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const publicDir = path.join(root, 'public');
const fixture = fs.readFileSync(path.join(root, 'scripts', 'test', 'fixtures', 'marketplace-paste.txt'), 'utf8');
const catalog = JSON.parse(fs.readFileSync(path.join(publicDir, 'catalog.json'), 'utf8'));
const PLAYWRIGHT_VERSION = process.env.PLAYWRIGHT_VERSION || '1.65.0';

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch {
        const out = execFileSync('npx', ['--yes', '-p', `playwright@${PLAYWRIGHT_VERSION}`, '-c', 'echo "$PATH"'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        const bin = out.trim().split(path.delimiter).find((p) => /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]\.bin$/.test(p));
        if (!bin) throw new Error('Could not locate Playwright via npx');
        return createRequire(path.join(bin, '..', 'noop.js'))('playwright');
    }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serve() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
        if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(cond, label, detail) {
    if (cond) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const { chromium } = await loadPlaywright();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true });

try {
    const context = await browser.newContext();
    const consoleErrors = [];
    const requested = [];
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: '' }));
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('request', (req) => requested.push(req.url()));

    const rows = () => page.$$eval('#comparison-body tr', (trs) => trs.map((tr) => ({
        id: tr.dataset.id, model: tr.dataset.model, price: Number(tr.dataset.price),
        value: tr.dataset.value, status: tr.dataset.status,
        champion: tr.classList.contains('champion-row'),
        incomplete: tr.classList.contains('incomplete-row'),
        score: tr.querySelector('.score-cell') ? tr.querySelector('.score-cell').textContent.trim() : null,
        valueText: tr.querySelector('.score-val') ? tr.querySelector('.score-val').textContent.trim() : null,
        os: tr.children[4] ? tr.children[4].textContent.trim() : null,
    })));
    const ready = () => page.waitForFunction(() => document.getElementById('model-search').placeholder.startsWith('Search'));

    async function search(query) {
        await page.fill('#model-search', '');
        await page.type('#model-search', query);
        await page.waitForSelector('#suggestions:not(.hidden) li');
        return page.$$eval('#suggestions li', (lis) => lis.map((li) => ({ id: li.dataset.id, text: li.textContent.trim() })));
    }
    async function addFromSearch(query, id, price) {
        const list = await search(query);
        await page.click(`#suggestions li[data-id="${id}"]`);
        await page.fill('#price-input', String(price));
        await page.click('#calculate-btn');
        return list;
    }

    console.log('Load');
    await page.goto(base);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await ready();
    const footer = (await page.textContent('footer')).trim();
    check(footer === `Scores: Geekbench 6 · data updated ${catalog.updated}`,
        'footer shows GB6 + catalog date', footer);

    console.log('Single search');
    let list = await addFromSearch('A2602', 'ipad-9th-generation', 200);
    check(list.length === 1 && list[0].id === 'ipad-9th-generation' && list[0].text.includes('iPad (9th generation)'),
        'A2602 -> iPad (9th generation)', list);
    list = await addFromSearch('iPad Pro 11 2018', 'ipad-pro-11', 390);
    check(list[0].id === 'ipad-pro-11' && list[0].text === 'iPad Pro 11-inch', '"iPad Pro 11 2018" -> 11-inch 1st gen', list);
    let r = await rows();
    check(r.some((x) => x.id === 'ipad-9th-generation' && x.price === 200 && x.os === `Latest (iPadOS ${catalog.latest_ipados})`),
        'iPad 9 row added with Latest OS', r);

    console.log('Bulk paste (fixture)');
    await page.click('.tab-btn[data-tab="pro"]');
    await page.fill('#bulk-input', fixture);
    await page.click('#process-bulk-btn');
    r = await rows();
    for (const [id, price] of [['ipad-air-5th-generation', 450], ['ipad-pro-11', 380], ['ipad-mini-6th-generation', 425]]) {
        check(r.some((x) => x.id === id && x.price === price && !x.incomplete), `bulk row ${id} @ $${price}`, r.map((x) => [x.id, x.price]));
    }

    console.log('Ambiguous paste -> Choose model');
    await page.fill('#bulk-input', 'iPad Air M4 $799');
    await page.click('#process-bulk-btn');
    r = await rows();
    const choose = r.find((x) => x.incomplete && x.model === 'iPad Air M4');
    check(choose && choose.valueText === 'Choose model', 'ambiguous listing added as "Choose model"', choose);
    await page.click('#comparison-body tr.incomplete-row .model-resolve-input');
    const options = await page.$$eval('#comparison-body tr.incomplete-row .suggestions-dropdown li', (lis) => lis.map((li) => li.dataset.id));
    check(options.length === 2 && options.includes('ipad-air-11-m4') && options.includes('ipad-air-13-m4'),
        'picker offers both M4 Airs', options);
    await page.click('#comparison-body tr.incomplete-row .suggestions-dropdown li[data-id="ipad-air-11-m4"]');

    console.log('Pending, converted, unsupported');
    r = await rows();
    const pending = r.find((x) => x.id === 'ipad-air-11-m4' && x.price === 799);
    check(pending && pending.score === 'Score pending' && pending.value === '' && pending.valueText === '—',
        'pending Air M4 shows "Score pending", no value', pending);
    check(pending && !pending.champion, 'pending row is not ranked best');
    check(r[r.length - 1].id === 'ipad-air-11-m4', 'pending row sorts last by value', r.map((x) => x.id));
    await page.click('.tab-btn[data-tab="basic"]');
    await addFromSearch('ipad mini a20 pro', 'ipad-mini-a20-pro', 650);
    const badge = await page.$eval('#comparison-body tr[data-id="ipad-mini-a20-pro"] .estimate-badge',
        (el) => ({ text: el.textContent, title: el.title }));
    check(badge.text === '≈' && badge.title === 'Estimated from Geekbench 7', 'converted score has ≈ badge', badge);
    await addFromSearch('ipad 2', 'ipad-2', 40);
    r = await rows();
    const old = r.find((x) => x.id === 'ipad-2');
    check(old && old.score === 'No GB6 score (too old)' && old.os === 'iOS 9' && !old.champion,
        'iPad 2 shows "No GB6 score (too old)", iOS 9, not best', old);

    const scored = r.filter((x) => x.value !== '');
    const bestVal = Math.max(...scored.map((x) => Number(x.value)));
    const champs = r.filter((x) => x.champion);
    check(champs.length === 1 && Number(champs[0].value) === bestVal, 'exactly one champion, with the best value', champs);

    console.log('Reload keeps rows');
    const before = (await rows()).map((x) => `${x.id}|${x.model}|${x.price}`).sort();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ipadComparisons')));
    check(stored.every((s) => Object.keys(s).sort().join() === 'id,model,price'), 'storage holds only {id, model, price}', stored[0]);
    await page.reload();
    await ready();
    const after = (await rows()).map((x) => `${x.id}|${x.model}|${x.price}`).sort();
    check(JSON.stringify(before) === JSON.stringify(after), `reload keeps ${after.length} rows`, { before, after });

    console.log('Old saved format migrates');
    await page.evaluate(() => localStorage.setItem('ipadComparisons', JSON.stringify([
        { model: 'iPad Air (6th)', price: '450', score: '9000', valueScore: '20.00', cpu: 'M2', released: '2024', max_os: 'Latest' },
        { model: 'iPadOS 16.1', price: '120', score: '0', valueScore: '0.00', cpu: '-', released: '-', max_os: '-' },
        { model: 'iPad Pro 11-inch (1st generation)', price: '380', score: '4500', valueScore: '11.84' },
    ])));
    await page.reload();
    await ready();
    r = await rows();
    check(r.length === 3, 'three migrated rows', r);
    check(r.some((x) => x.id === 'ipad-pro-11' && x.price === 380), 'old 11-inch name resolves to ipad-pro-11');
    check(r.some((x) => x.incomplete && x.model === 'iPad Air (6th)' && x.valueText === 'Choose model'), '"iPad Air (6th)" -> Choose model');
    check(r.some((x) => x.incomplete && x.model === 'iPadOS 16.1' && x.valueText === 'Unknown model'), '"iPadOS 16.1" kept as unknown model');

    console.log('Network + console');
    check(!requested.some((u) => /firebase|firestore|model_specs|model_mapping/i.test(u)), 'no Firebase/old-data requests',
        requested.filter((u) => /firebase|firestore|model_/i.test(u)));
    check(consoleErrors.length === 0, 'no console errors', consoleErrors);

    console.log('Catalog load failure');
    const ctx2 = await browser.newContext();
    await ctx2.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: '' }));
    await ctx2.route('**/catalog.json', (route) => route.fulfill({ status: 500, body: 'boom' }));
    const page2 = await ctx2.newPage();
    await page2.goto(base);
    await page2.waitForFunction(() => document.getElementById('model-search').placeholder !== 'Loading data...');
    const state = await page2.$eval('#model-search', (el) => ({ placeholder: el.placeholder, disabled: el.disabled }));
    check(state.placeholder === "Couldn't load iPad data — reload" && state.disabled, 'failed catalog shows reload message', state);
    await ctx2.close();
} finally {
    await browser.close();
    server.close();
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
