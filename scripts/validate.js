#!/usr/bin/env node
'use strict';

// Usage: node validate.js [path] [--previous path]
const fs = require('fs');
const path = require('path');
const { validateCatalog } = require('./lib/validate');

const args = process.argv.slice(2);
let file = path.join(__dirname, '..', 'public', 'catalog.json');
let previousPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--previous') previousPath = args[++i];
  else file = args[i];
}

function load(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

let errors;
try {
  const previous = previousPath ? load(previousPath) : undefined;
  errors = validateCatalog(load(file), { previous });
} catch (e) {
  errors = [`catalog: ${e.message}`];
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`${file}: valid`);
