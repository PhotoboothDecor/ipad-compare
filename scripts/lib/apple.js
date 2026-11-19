'use strict';

const cheerio = require('cheerio');
const { normalizeName, slugify } = require('./names');

const USER_AGENT = 'ipad-compare-bot (+https://github.com/PhotoboothDecor/ipad-compare)';
const IDENTIFY_URL = 'https://support.apple.com/en-us/108043';
const COMPAT_URL = 'https://support.apple.com/guide/ipad/ipad213a25b2/ipados';
const MIN_SPACING_MS = 10000;
const BACKOFF_MS = [30000, 60000, 120000];

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throttled, retrying fetcher: requests >= 10 s apart; 429/5xx retried after 30/60/120 s.
function makeFetchApple({ fetch = globalThis.fetch, sleep = realSleep, now = Date.now } = {}) {
  let last = null;
  return async function fetchApple(url) {
    for (let attempt = 0; ; attempt++) {
      if (last !== null) {
        const wait = last + MIN_SPACING_MS - now();
        if (wait > 0) await sleep(wait);
      }
      last = now();
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
      if (res.ok) return res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= BACKOFF_MS.length) {
        throw new Error(`GET ${url}: HTTP ${res.status}`);
      }
      await sleep(BACKOFF_MS[attempt]);
    }
  };
}

const fetchApple = makeFetchApple();

const clean = (s) => String(s).replace(/[\u00a0\u202f]/g, ' ').replace(/[\u2010\u2011]/g, '-').replace(/\s+/g, ' ').trim();

// https://support.apple.com/en-us/108043 -> [{name, a_numbers, year}]
function parseIdentifyPage(html) {
  const $ = cheerio.load(html);
  const models = [];
  const owner = new Map();
  $('h2.gb-header').each((_, h) => {
    const name = clean($(h).text());
    let text = '';
    for (let n = h.nextSibling; n; n = n.nextSibling) {
      if (n.type === 'tag' && n.name === 'h2' && $(n).hasClass('gb-header')) break;
      text += ' ' + $(n).text();
    }
    const aNumbers = [...new Set(text.match(/A\d{4}/g) || [])];
    const y = /Year:[^0-9]*?(\d{4})/.exec(text);
    if (aNumbers.length === 0 && !y) return; // e.g. "Find the model number"
    if (aNumbers.length === 0 || !y) throw new Error(`Identify page: "${name}" has ${aNumbers.length} A-numbers and ${y ? 'a' : 'no'} year`);
    for (const a of aNumbers) {
      if (owner.has(a)) throw new Error(`Identify page: ${a} appears under "${owner.get(a)}" and "${name}"`);
      owner.set(a, name);
    }
    models.push({ name, a_numbers: aNumbers, year: Number(y[1]) });
  });
  if (models.length < 40) throw new Error(`Identify page: only ${models.length} models found (expected >= 40)`);
  return models;
}

// Topic id = last "-" segment of the topic slug. iPadOS 13 links use /guide/ipad/aside/<id>/.
function topicIdFromHref(href) {
  const parts = new URL(href, 'https://support.apple.com').pathname.split('/').filter(Boolean);
  const i = parts.indexOf('ipad');
  let slug = parts[i + 1];
  if (slug === 'aside') slug = parts[i + 2];
  if (!slug) throw new Error(`Compat page: cannot read topic id from ${href}`);
  return slug.split('-').pop();
}

// Version comes from the page itself, never from the URL: unknown-version URLs serve the latest.
function pageVersion($) {
  const h1 = /iPadOS (\d+)/.exec(clean($('h1').first().text()));
  if (h1) return Number(h1[1]);
  // The iPadOS 13 guide's h1 is just "Supported iPad models"; its description names the version.
  const desc = /support iPadOS (\d+)/.exec($('meta[name="description"]').attr('content') || '');
  if (desc && /^Supported iPad models$/.test(clean($('h1').first().text()))) return Number(desc[1]);
  return null;
}

function parseCompatPage(html) {
  const $ = cheerio.load(html, { scriptingEnabled: false }); // version list lives in <noscript>
  const version = pageVersion($);
  if (version === null) throw new Error('Compat page: no iPadOS version in <h1>');
  const models = [];
  const seen = new Set();
  $('table[aria-label="iPad models"] a.xRef').each((_, a) => {
    const name = clean($(a).text());
    const topic_id = topicIdFromHref($(a).attr('href'));
    const key = `${normalizeName(name)}|${topic_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ name, topic_id });
  });
  if (models.length < 10) throw new Error(`Compat page iPadOS ${version}: only ${models.length} models found (expected >= 10)`);
  const versions = [];
  $('#nojs-version-name a').each((_, a) => {
    const m = /iPadOS (\d+)/.exec(clean($(a).text()));
    if (m) versions.push({ version: Number(m[1]), url: new URL($(a).attr('href'), 'https://support.apple.com').href });
  });
  return { version, models, versions };
}

const FAMILY = [[/^ipad pro\b/, 'pro'], [/^ipad air\b/, 'air'], [/^ipad mini\b/, 'mini'], [/^ipad\b/, 'ipad']];

function newModel(m) {
  const n = normalizeName(m.name);
  const family = FAMILY.find(([re]) => re.test(n))[1];
  const size = /(\d+(?:\.\d+)?)-inch/.exec(n);
  const chip = /\(([AM]\d+[A-Z]?(?: Pro)?)\)/.exec(m.name);
  return {
    id: slugify(m.name),
    name: m.name,
    family,
    size_in: size ? Number(size[1]) : null,
    chip: chip ? chip[1] : 'unknown',
    released: m.year,
    a_numbers: [...m.a_numbers].sort(),
    max_os_major: m.max_os_major,
    apple_topic_id: m.topic_id || null,
    names: { apple: [m.name], geekbench: [], aliases: [] },
    score_status: 'pending',
    score: null,
  };
}

// Exact normalized-name index over name + names.apple.
function nameIndex(models) {
  const idx = new Map();
  for (const m of models) {
    for (const n of [m.name, ...m.names.apple]) idx.set(normalizeName(n), m);
  }
  return idx;
}

/**
 * Compare Apple's pages with the catalog. Returns a new catalog (input untouched) and the list of changes.
 * Never removes data; joins by exact normalized name, topic id or A-number only.
 */
function diffCatalog(catalog, identify, compatPages) {
  const cat = structuredClone(catalog);
  const changes = [];
  const pages = [...compatPages].sort((a, b) => b.version - a.version);
  if (pages.length === 0) throw new Error('No compat pages');
  const latest = pages[0].version;
  if (latest < cat.latest_ipados) {
    throw new Error(`latest_ipados would decrease from ${cat.latest_ipados} to ${latest}`);
  }

  // Highest version listing each topic id / normalized name.
  const maxByTopic = new Map();
  const maxByName = new Map();
  const topicByName = new Map();
  for (const p of pages) {
    for (const m of p.models) {
      const n = normalizeName(m.name);
      if (!maxByTopic.has(m.topic_id)) maxByTopic.set(m.topic_id, p.version);
      if (!maxByName.has(n)) { maxByName.set(n, p.version); topicByName.set(n, m.topic_id); }
    }
  }

  // 1. Identify page -> new models / new A-numbers.
  let idx = nameIndex(cat.models);
  for (const im of identify) {
    const existing = idx.get(normalizeName(im.name));
    if (existing) {
      const added = im.a_numbers.filter((a) => !existing.a_numbers.includes(a));
      if (added.length) {
        existing.a_numbers = [...existing.a_numbers, ...added].sort();
        changes.push({ kind: 'a_numbers_added', id: existing.id, name: existing.name, added });
      }
      continue;
    }
    const n = normalizeName(im.name);
    const maxOs = maxByName.get(n);
    if (maxOs === undefined) {
      throw new Error(`New model "${im.name}" on the identify page is not on any compat page; cannot set max_os_major`);
    }
    const model = newModel({ ...im, max_os_major: maxOs, topic_id: topicByName.get(n) });
    cat.models.push(model);
    idx = nameIndex(cat.models);
    changes.push({ kind: 'new_model', id: model.id, name: model.name, model });
  }

  // 2. Compat pages -> max OS (topic id first, exact name fallback).
  const missing = [];
  for (const m of cat.models) {
    let found = m.apple_topic_id ? maxByTopic.get(m.apple_topic_id) : undefined;
    if (found === undefined) {
      for (const n of [m.name, ...m.names.apple]) {
        const v = maxByName.get(normalizeName(n));
        if (v !== undefined && (found === undefined || v > found)) found = v;
      }
    }
    if (found === undefined) {
      if (m.max_os_major >= 13 && m.released >= 2015) missing.push(m.id);
      continue;
    }
    if (found !== m.max_os_major) {
      changes.push({ kind: 'max_os_changed', id: m.id, name: m.name, from: m.max_os_major, to: found });
      m.max_os_major = found;
    }
  }

  if (missing.length) {
    throw new Error(`Not found on any compat page: ${missing.join(', ')}`);
  }

  if (latest !== cat.latest_ipados) {
    changes.push({ kind: 'latest_ipados_changed', from: cat.latest_ipados, to: latest });
    cat.latest_ipados = latest;
  }

  return { changes, catalog: cat };
}

const KIND_TITLES = {
  latest_ipados_changed: 'Latest iPadOS',
  new_model: 'New models',
  a_numbers_added: 'A-numbers added',
  max_os_changed: 'Max iPadOS changed',
};

function summarize(changes) {
  const lines = ['# Apple data check', ''];
  if (changes.length === 0) return lines.concat('No changes', '').join('\n');
  for (const [kind, title] of Object.entries(KIND_TITLES)) {
    const cs = changes.filter((c) => c.kind === kind);
    if (!cs.length) continue;
    lines.push(`## ${title}`, '');
    for (const c of cs) {
      if (kind === 'latest_ipados_changed') lines.push(`- ${c.from} → ${c.to}`);
      else if (kind === 'new_model') lines.push(`- ${c.name} (\`${c.id}\`): ${c.model.a_numbers.join(', ')}; max iPadOS ${c.model.max_os_major}; score pending`);
      else if (kind === 'a_numbers_added') lines.push(`- ${c.name} (\`${c.id}\`): ${c.added.join(', ')}`);
      else lines.push(`- ${c.name} (\`${c.id}\`): ${c.from} → ${c.to}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  USER_AGENT, IDENTIFY_URL, COMPAT_URL,
  makeFetchApple, fetchApple, parseIdentifyPage, parseCompatPage, topicIdFromHref, diffCatalog, summarize,
};
