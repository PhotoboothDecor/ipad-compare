/**
 * iPad model matcher + Facebook Marketplace paste helpers.
 * UMD: window.IPadMatcher in the browser, module.exports in Node (tests).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.IPadMatcher = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function getOrdinal(n) {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    /**
     * Parse Facebook Marketplace paste into listing blocks.
     * Each listing follows the pattern:
     *   [Title] in [City], [Province]   <- block start
     *   CA$[price]                      <- current price
     *   CA$[original price]             <- optional struck-through price
     *   [Title]                         <- duplicate title (no location)
     *   [City], [Province]              <- standalone location
     *   [Just listed]                   <- optional tag
     *
     * Returns array of { rawTitle, price } objects, or null if not Facebook format.
     */
    function parseFacebookBlocks(rawText) {
        const lines = rawText.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);

        const locationSuffix = /\s+in\s+([\w\u00C0-\u024F\s.\-']+),\s*([A-Z]{2})\s*$/;
        const priceRegex = /^(?:CA\$|CAD\s*\$?|US\$|USD\s*\$?|\$)\s*([\d,]+)\s*$/i;

        const blockStarts = [];
        for (let i = 0; i < lines.length; i++) {
            if (locationSuffix.test(lines[i])) {
                blockStarts.push(i);
            }
        }

        if (blockStarts.length < 1) {
            return null;
        }

        const listings = [];
        for (let b = 0; b < blockStarts.length; b++) {
            const startIdx = blockStarts[b];
            const endIdx = (b + 1 < blockStarts.length) ? blockStarts[b + 1] : lines.length;
            const blockLines = lines.slice(startIdx, endIdx);

            const titleLine = blockLines[0];
            const rawTitle = titleLine.replace(locationSuffix, '').trim();

            const prices = [];
            for (let j = 1; j < blockLines.length; j++) {
                const line = blockLines[j];
                if (/^free$/i.test(line)) continue;
                const match = line.match(priceRegex);
                if (match) {
                    const val = parseInt(match[1].replace(/,/g, ''), 10);
                    if (val > 0) prices.push(val);
                }
            }

            const price = prices.length > 0 ? Math.min(...prices) : null;

            if (price !== null) {
                listings.push({ rawTitle, price });
            }
        }

        return listings;
    }

    /**
     * Clean a raw listing title for model matching.
     * Strips noise (colors, storage, condition, accessories, etc.)
     * and normalizes French generations and shorthand.
     */
    function cleanTitle(raw) {
        let t = raw;

        t = t.replace(/[\[(](sealed|new|used|mint|trading)[\])]/gi, '');
        t = t.replace(/^(New|Brand New|Like New|Used|Mint|Sealed)\s+/i, '');
        t = t.replace(/^Apple\s+/i, '');
        t = t.replace(/^\$\d+\s+/i, '');
        t = t.replace(/^(?:CA\$|CAD\s*\$?)\s*\d+\s+/i, '');
        t = t.replace(/\b\d+\s*(GB|TB|gb|tb)\b/gi, '');
        t = t.replace(/\b(Blue|Pink|Yellow|Silver|Gold|Space\s*Gr[ae]y|White|Black|Starlight|Purple|Red)\b/gi, '');
        t = t.replace(/\b(Wi-?Fi|WiFi|Cellular|Wi-?Fi\s*\+\s*Cellular|4G\s*LTE|LTE)\b/gi, '');
        t = t.replace(/\b(Like New|Condition|pristine condition|Fully functional|very good battery|Fully clean|abd ready)\b/gi, '');
        t = t.replace(/\+\s*.*$/i, '');
        t = t.replace(/\bwith\s+(?!Wi).*$/i, '');
        t = t.replace(/\bfor\s+(sale|parts)\b/gi, '');
        t = t.replace(/Released:\s*\w+\s*\d{4}/gi, '');
        t = t.replace(/Wi-?Fi\s*Model/gi, '');

        // Normalize French generations
        t = t.replace(/(\d+)(?:ème|e|ère)\s*(?:génération|gen\.?)/gi, (_, num) => {
            return getOrdinal(parseInt(num)) + ' generation';
        });

        // Normalize "GEN." / "Gen" / "Generation" shorthand
        t = t.replace(/(\d+)(?:ST|ND|RD|TH)?\s*GEN(?:ERATION)?\.?\s*/gi, (_, num) => {
            return getOrdinal(parseInt(num)) + ' generation ';
        });

        t = t.replace(/^TRADING\s*\|\s*/i, '');
        t = t.replace(/\s*[•·]\s*/g, ' ');

        // Normalize year-as-generation for Pro models
        const proYearMap = {
            '2018': { '11': 'iPad Pro 11-inch (1st generation)', '12.9': 'iPad Pro 12.9-inch (3rd generation)', default: 'iPad Pro 11-inch (1st generation)' },
            '2020': { '11': 'iPad Pro 11-inch (2nd generation)', '12.9': 'iPad Pro 12.9-inch (4th generation)', default: 'iPad Pro 11-inch (2nd generation)' },
            '2021': { '11': 'iPad Pro 11-inch (3rd generation)', '12.9': 'iPad Pro 12.9-inch (5th generation)', default: 'iPad Pro 11-inch (3rd generation)' },
            '2022': { '11': 'iPad Pro 11-inch (4th generation)', '12.9': 'iPad Pro 12.9-inch (6th generation)', default: 'iPad Pro 11-inch (4th generation)' },
            '2024': { '11': 'iPad Pro 11-inch (M4)', '13': 'iPad Pro 13-inch (M4)', default: 'iPad Pro 11-inch (M4)' },
            '2025': { '11': 'iPad Pro 11-inch (M5)', '13': 'iPad Pro 13-inch (M5)', default: 'iPad Pro 11-inch (M5)' },
        };
        const proYearMatch = t.match(/ipad\s*pro\s*([\d.]+)?.*?\b(20\d{2})\b/i);
        if (proYearMatch) {
            const size = proYearMatch[1] || null;
            const year = proYearMatch[2];
            const yearEntry = proYearMap[year];
            if (yearEntry) {
                const sizeKey = size ? Object.keys(yearEntry).find(k => size.startsWith(k)) : null;
                t = sizeKey ? yearEntry[sizeKey] : yearEntry.default;
                return t;
            }
        }

        t = t.replace(/[.\-–—,;:!]+\s*$/, '');
        t = t.replace(/\s+/g, ' ').trim();

        return t;
    }

    /**
     * Pre-filter: determine if a listing title is actually an iPad for sale
     * (not an accessory, not Samsung, etc.)
     * Returns false if the listing should be skipped entirely.
     */
    function isIPadListing(rawTitle) {
        const t = rawTitle.toLowerCase();

        if (!t.includes('ipad')) return false;

        if (/\bfor\s+ipad\b/i.test(rawTitle)) return false;
        if (/\bcase\b.*\bipad\b/i.test(rawTitle) && !/\bipad\b.*\bcase\b/i.test(rawTitle)) return false;
        if (/\baccessor(?:y|ies)\s+bundle\b/i.test(rawTitle)) return false;
        if (/\bipad\b.*\baccessor(?:y|ies)\b/i.test(rawTitle)) return false;

        if (/^samsung\b/i.test(rawTitle)) return false;
        if (/^logitech\b/i.test(rawTitle)) return false;
        if (/^microsoft\b/i.test(rawTitle)) return false;

        return true;
    }
    // --- Model matcher (works on catalog.json) ---

    const FAMILY_WORDS = ['mini', 'air', 'pro']; // precedence when several appear

    function normalizeANumber(a) {
        const m = String(a || '').toUpperCase().match(/\bA(\d{4})\b/);
        return m ? 'A' + m[1] : null;
    }

    function chipKey(chip) {
        return String(chip || '').toLowerCase().split(/\s+/)[0];
    }

    /** Lowercase once, normalize punctuation, split into tokens. */
    function tokenize(query) {
        const q = String(query || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[\u00a0\u2010-\u2015]/g, ' ')
            .replace(/(\d)(?:\s*(?:"|\u201d|\u2033|\u2032\u2032|''|-?\s*inch(?:es)?\b)|in\b)/g, '$1 inch ');
        return q.split(/[^a-z0-9.]+/)
            .map((t) => t.replace(/^\.+|\.+$/g, ''))
            .filter((t) => t.length > 0)
            .map((t) => (t === 'ipads' ? 'ipad' : t));
    }

    /** Pull structured attributes out of query tokens. */
    function parseQuery(tokens, models, defaultFamily) {
        const out = {
            family: null, sizes: [], gens: [], chips: [], years: [],
            aliasText: tokens.join(' '),
        };
        const consumed = new Set();

        // Chips first: "a17 pro" / "a20 pro" — the "pro" belongs to the chip.
        tokens.forEach((t, i) => {
            if (/^[am]\d{1,2}[xz]?$/.test(t)) {
                out.chips.push(t);
                consumed.add(i);
                if (t[0] === 'a' && tokens[i + 1] === 'pro') consumed.add(i + 1);
            } else if (/^a\d{4}$/.test(t)) {
                consumed.add(i); // unknown A-number: ignore, don't read as a generation
            }
        });

        for (const fam of FAMILY_WORDS) {
            if (tokens.some((t, i) => t === fam && !consumed.has(i))) { out.family = fam; break; }
        }
        tokens.forEach((t, i) => { if (FAMILY_WORDS.includes(t)) consumed.add(i); });
        if (tokens.includes('original')) out.gens.push(1);

        const poolFamily = out.family || defaultFamily;
        const pool = poolFamily ? models.filter((m) => m.family === poolFamily) : models;
        const poolSizes = new Set(pool.map((m) => m.size_in).filter((s) => s != null));

        const ORDINAL = /^(\d+)(?:st|nd|rd|th|e)$/;
        const isGenWord = (t) => t === 'gen' || t === 'generation';
        tokens.forEach((t, i) => {
            if (consumed.has(i)) return;
            const next = tokens[i + 1];
            const prev = tokens[i - 1];
            let m;
            if ((m = t.match(ORDINAL))) {
                out.gens.push(parseInt(m[1], 10));
            } else if (/^(19|20)\d{2}$/.test(t)) {
                out.years.push(parseInt(t, 10));
            } else if (/^\d+(\.\d+)?$/.test(t)) {
                const n = parseFloat(t);
                if (next === 'gb' || next === 'tb') return;          // "256 GB" storage
                if (i === 0 && next === 'ipad') return;              // "2 iPads for sale" count
                if (next === 'inch' || !Number.isInteger(n)) {       // never a generation
                    out.sizes.push(n);
                    return;
                }
                // "gen 6" / "6 gen" make it a generation, but not in "3rd gen 12",
                // where the gen word belongs to the ordinal before it.
                const genAfter = isGenWord(next);
                const genBefore = isGenWord(prev) && !ORDINAL.test(tokens[i - 2] || '');
                if (!genAfter && !genBefore && poolSizes.has(n)) out.sizes.push(n);
                else out.gens.push(n);
            }
        });
        return out;
    }

    function canonicalPhrase(s) {
        return tokenize(s).filter((t) => t !== 'apple').join(' ');
    }

    function createMatcher(catalog) {
        const models = (catalog && catalog.models) || [];
        const byId = new Map();
        const byA = new Map();
        for (const m of models) {
            byId.set(m.id, m);
            for (const a of m.a_numbers || []) byA.set(a.toUpperCase(), m);
        }
        // Whole-token alias phrases (aliases + Geekbench names; Apple names are
        // covered by the attribute match and some, like "iPad Air", are ambiguous).
        const aliasPhrases = new Map(models.map((m) => [m.id,
            [...((m.names && m.names.aliases) || []), ...((m.names && m.names.geekbench) || [])]
                .map(canonicalPhrase).filter((p) => p.length > 0)]));

        const newestFirst = (a, b) => (b.released - a.released) || ((b.size_in || 0) - (a.size_in || 0));

        function result(m, matchType, relevance, ambiguous) {
            return { id: m.id, name: m.name, matchType, relevance, ambiguous };
        }

        function byANumber(a) {
            const key = normalizeANumber(a);
            return (key && byA.get(key)) || null;
        }

        function get(id) {
            return byId.get(id) || null;
        }

        function score(m, q) {
            // An attribute the model lacks (size_in/generation null) is neutral.
            let matches = 0;
            let mismatches = 0;
            const check = (wanted, actual) => {
                if (!wanted.length || actual == null) return;
                if (wanted.includes(actual)) matches++; else mismatches++;
            };
            check(q.sizes, m.size_in);
            check(q.gens, m.generation);
            check(q.years, m.released);
            check(q.chips, chipKey(m.chip));
            const matchType = (q.gens.length || q.sizes.length) ? 'name'
                : q.chips.length ? 'cpu' : 'year';
            let relevance = 100 * matches - 100 * mismatches;
            if (relevance > 0) {
                const padded = ' ' + q.aliasText + ' ';
                if (aliasPhrases.get(m.id).some((p) => padded.includes(' ' + p + ' '))) relevance += 20;
            }
            return { relevance, matchType };
        }

        function find(query, limit = 10) {
            const tokens = tokenize(query);
            if (tokens.length === 0) return [];

            // 1. A-numbers: exact lookup; a hit returns only that model.
            for (const t of tokens) {
                if (/^a\d{4}$/.test(t)) {
                    const m = byANumber(t);
                    if (m) return [result(m, 'number', 1000, false)];
                }
            }

            // "ipad ..." without a family word means the base iPad; if nothing
            // fits there, re-read the query against every family.
            const hasIpad = tokens.includes('ipad');
            const q = parseQuery(tokens, models, hasIpad ? 'ipad' : null);
            const discriminators = q.sizes.length + q.gens.length + q.chips.length + q.years.length;

            // 2. Bare family ("ipad air", "ipad pro", "ipad mini"): not precise.
            if (discriminators === 0) {
                if (!q.family) return [];
                return models.filter((m) => m.family === q.family)
                    .slice().sort(newestFirst)
                    .slice(0, limit)
                    .map((m) => result(m, 'fuzzy', 0, true));
            }

            // 3. Attribute scoring: every matched attribute +100, every
            //    contradicted one -100; only net-positive models are returned.
            const run = (pool, qq) => pool
                .map((m) => ({ m, s: score(m, qq) }))
                .filter((x) => x.s.relevance > 0)
                .sort((a, b) => (b.s.relevance - a.s.relevance) || newestFirst(a.m, b.m))
                .map((x) => result(x.m, x.s.matchType, x.s.relevance, false));

            let out;
            const flagTies = (list) => {
                const tied = list.length > 1 && list[0].relevance === list[1].relevance;
                return tied ? list.map((r) => ({ ...r, ambiguous: true })) : list;
            };
            if (q.family) {
                out = run(models.filter((m) => m.family === q.family), q);
            } else if (hasIpad) {
                out = run(models.filter((m) => m.family === 'ipad'), q);
                if (out.length === 0) out = run(models, parseQuery(tokens, models, null));
            } else {
                out = run(models, q);
            }
            // Several models sharing the top relevance: the query isn't precise.
            return flagTies(out).slice(0, limit);
        }

        return { find, byANumber, get };
    }

    // --- App data helpers (pure; used by app.js, tested in Node) ---

    /** "Latest (iPadOS 27)" for current devices, "iPadOS N", or "iOS N" before iPadOS 13. */
    function displayMaxOS(model, latestIpados) {
        const n = model && model.max_os_major;
        if (n == null) return '?';
        if (n === latestIpados) return `Latest (iPadOS ${n})`;
        return n < 13 ? `iOS ${n}` : `iPadOS ${n}`;
    }

    /** GB6 multi-core points per dollar; null unless the score is usable and price > 0. */
    function valueOf(model, price) {
        const p = Number(price);
        if (!model || model.score_status !== 'ok' || !model.score) return null;
        if (!Number.isFinite(p) || p <= 0) return null;
        const s = model.score.gb6_multi;
        return (typeof s === 'number' && s > 0) ? s / p : null;
    }

    /**
     * Turn find() results into a decision: a single id when the top result is
     * unambiguous, otherwise the tied top candidates for the user to choose from.
     */
    function resolveMatch(results) {
        if (!results || results.length === 0) return { id: null, candidates: [] };
        const top = results[0];
        if (!top.ambiguous) return { id: top.id, candidates: [] };
        const candidates = results
            .filter((r) => r.ambiguous && r.relevance === top.relevance)
            .map((r) => r.id);
        return { id: null, candidates };
    }

    /**
     * Sort row items by `column`; null/undefined/NaN values always go last,
     * whatever the direction. Strings compare case-insensitively. Returns a new array.
     */
    function rankRows(items, column, direction) {
        const dir = direction === 'asc' ? 1 : -1;
        const isMissing = (v) => v == null || (typeof v === 'number' && Number.isNaN(v));
        return (items || []).slice().sort((a, b) => {
            let va = a[column];
            let vb = b[column];
            const ma = isMissing(va);
            const mb = isMissing(vb);
            if (ma || mb) return (ma === mb) ? 0 : (ma ? 1 : -1);
            if (typeof va === 'string' || typeof vb === 'string') {
                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
            }
            if (va < vb) return -dir;
            if (va > vb) return dir;
            return 0;
        });
    }

    /** The item with the highest non-null `value`, or null if none has one. */
    function pickBest(items) {
        let best = null;
        for (const it of items || []) {
            if (typeof it.value !== 'number' || !Number.isFinite(it.value)) continue;
            if (!best || it.value > best.value) best = it;
        }
        return best;
    }

    /**
     * Migrate rows saved in localStorage (old: {model, price, score, ...};
     * new: {id, model, price}) to {id|null, model, price[, candidates]}.
     * Known ids are kept; otherwise the saved name is re-resolved with find().
     * Unresolvable or ambiguous names stay as unknown rows (id null) the user can fix.
     * Rows without a positive price are dropped.
     */
    function migrateSaved(rows, matcher) {
        if (!Array.isArray(rows)) return [];
        const out = [];
        for (const r of rows) {
            if (!r || typeof r !== 'object') continue;
            const price = Number(r.price);
            if (!Number.isFinite(price) || price <= 0) continue;
            const known = r.id ? matcher.get(r.id) : null;
            if (known) {
                out.push({ id: known.id, model: known.name, price });
                continue;
            }
            const name = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : 'Unknown model';
            const { id, candidates } = resolveMatch(matcher.find(name));
            if (id) out.push({ id, model: matcher.get(id).name, price });
            else out.push({ id: null, model: name, price, candidates });
        }
        return out;
    }

    return {
        createMatcher, parseFacebookBlocks, cleanTitle, isIPadListing, getOrdinal, tokenize,
        displayMaxOS, valueOf, resolveMatch, rankRows, pickBest, migrateSaved,
    };
}));
