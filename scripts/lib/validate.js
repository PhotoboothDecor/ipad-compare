'use strict';

const Ajv = require('ajv');
const { normalizeName } = require('./names');

const BAD_GB6_MULTI = new Set([10000, 9660, 10100, 14500]);

const scoreSchema = {
  type: 'object',
  required: ['gb6_multi', 'gb6_single', 'source', 'gb7_multi', 'gb7_single', 'ratio_multi', 'ratio_single', 'captured'],
  properties: {
    gb6_multi: { type: 'integer' },
    gb6_single: { type: 'integer' },
    source: { enum: ['gb6', 'gb7-converted'] },
    gb7_multi: { type: ['integer', 'null'] },
    gb7_single: { type: ['integer', 'null'] },
    ratio_multi: { type: ['number', 'null'] },
    ratio_single: { type: ['number', 'null'] },
    captured: { type: 'string' },
  },
};

const schema = {
  type: 'object',
  required: ['schema_version', 'updated', 'latest_ipados', 'models'],
  properties: {
    schema_version: { const: 1 },
    updated: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    latest_ipados: { type: 'integer' },
    models: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'family', 'size_in', 'chip', 'released', 'a_numbers', 'max_os_major',
          'apple_topic_id', 'names', 'score_status', 'score'],
        properties: {
          id: { type: 'string', pattern: '^ipad[a-z0-9-]+$' },
          name: { type: 'string', minLength: 1 },
          family: { enum: ['ipad', 'air', 'mini', 'pro'] },
          size_in: { type: ['number', 'null'] },
          chip: { type: 'string', minLength: 1 },
          released: { type: 'integer', minimum: 2010 },
          a_numbers: { type: 'array', items: { type: 'string', pattern: '^A\\d{4}$' } },
          max_os_major: { type: 'integer' },
          generation: { type: ['integer', 'null'], minimum: 1 }, // optional: Apple's generation number, shared across sizes
          apple_topic_id: { type: ['string', 'null'] },
          names: {
            type: 'object',
            required: ['apple', 'geekbench', 'aliases'],
            properties: {
              apple: { type: 'array', items: { type: 'string' } },
              geekbench: { type: 'array', items: { type: 'string' } },
              aliases: { type: 'array', items: { type: 'string' } },
            },
          },
          score_status: { enum: ['ok', 'pending', 'unsupported'] },
          score: { anyOf: [{ type: 'null' }, scoreSchema] },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true });
const validateShape = ajv.compile(schema);

function validateCatalog(catalog, { previous, now = new Date() } = {}) {
  const errors = [];

  if (!validateShape(catalog)) {
    for (const e of validateShape.errors) {
      const m = /^\/models\/(\d+)/.exec(e.instancePath);
      let who = 'catalog';
      if (m) {
        const mod = catalog.models && catalog.models[Number(m[1])];
        who = (mod && mod.id) || `models[${m[1]}]`;
      }
      errors.push(`${who}: schema ${e.instancePath || '/'} ${e.message}`);
    }
    return errors; // cross-record rules assume a valid shape
  }

  const year = now.getFullYear();
  const ids = new Set();
  const aNumbers = new Map();
  const names = new Map();

  for (const m of catalog.models) {
    if (ids.has(m.id)) errors.push(`${m.id}: duplicate id`);
    ids.add(m.id);

    for (const a of m.a_numbers) {
      if (aNumbers.has(a) && aNumbers.get(a) !== m.id) {
        errors.push(`${m.id}: A-number ${a} also used by ${aNumbers.get(a)}`);
      } else {
        aNumbers.set(a, m.id);
      }
    }

    const mine = new Set(
      [m.name, ...m.names.apple, ...m.names.geekbench, ...m.names.aliases].map(normalizeName),
    );
    for (const n of mine) {
      if (names.has(n) && names.get(n) !== m.id) {
        errors.push(`${m.id}: name "${n}" also used by ${names.get(n)}`);
      } else {
        names.set(n, m.id);
      }
    }

    if (m.released > year) errors.push(`${m.id}: released ${m.released} is after current year ${year}`);
    if (m.max_os_major > catalog.latest_ipados) {
      errors.push(`${m.id}: max_os_major ${m.max_os_major} exceeds latest_ipados ${catalog.latest_ipados}`);
    }

    if (m.score_status === 'ok' && m.score === null) {
      errors.push(`${m.id}: score_status is "ok" but score is null`);
    }
    if (m.score_status !== 'ok' && m.score !== null) {
      errors.push(`${m.id}: score_status is "${m.score_status}" but score is not null`);
    }

    const s = m.score;
    if (s) {
      if (BAD_GB6_MULTI.has(s.gb6_multi)) {
        errors.push(`${m.id}: gb6_multi ${s.gb6_multi} is a known placeholder value`);
      }
      if (s.gb6_multi < 300 || s.gb6_multi > 30000) {
        errors.push(`${m.id}: gb6_multi ${s.gb6_multi} outside 300-30000`);
      }
      if (s.source === 'gb7-converted') {
        if (s.gb7_multi === null) errors.push(`${m.id}: gb7-converted requires gb7_multi`);
        if (s.ratio_multi === null || s.ratio_multi < 0.8 || s.ratio_multi > 1.2) {
          errors.push(`${m.id}: ratio_multi ${s.ratio_multi} outside 0.8-1.2`);
        }
      }
    }
  }

  if (previous && Array.isArray(previous.models)) {
    if (catalog.models.length < previous.models.length) {
      errors.push(`catalog: model count dropped from ${previous.models.length} to ${catalog.models.length}`);
    }
    for (const p of previous.models) {
      if (!ids.has(p.id)) errors.push(`${p.id}: missing from catalog (present in previous)`);
    }
  }

  return errors;
}

module.exports = { validateCatalog };
