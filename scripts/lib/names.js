'use strict';

// Lowercase, NFKC, nbsp/U+2011 -> space/hyphen, strip parens, collapse spaces.
function normalizeName(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[   ]/g, ' ')
    .replace(/[‐‑‒–]/g, '-')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "iPad Air 11-inch (M4)" -> "ipad-air-11-m4"
function slugify(name) {
  return normalizeName(name)
    .replace(/-inch\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { normalizeName, slugify };
