document.addEventListener('DOMContentLoaded', () => {
    // Matching, listing-parse and value helpers live in matcher.js (window.IPadMatcher).
    const {
        createMatcher, parseFacebookBlocks, cleanTitle, isIPadListing,
        displayMaxOS, valueOf, resolveMatch, rankRows, pickBest, migrateSaved,
    } = window.IPadMatcher;
    const modelSearchInput = document.getElementById('model-search');
    const searchResults = document.getElementById('suggestions');
    const priceInput = document.getElementById('price-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const selectedModelIdInput = document.getElementById('selected-model-id');
    const resultContainer = document.getElementById('result-container');
    const comparisonBody = document.getElementById('comparison-body');
    const clearAllBtn = document.getElementById('clear-all-btn');
    const dataUpdatedEl = document.getElementById('data-updated');

    // Tab Elements
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const bulkInput = document.getElementById('bulk-input');
    const processBulkBtn = document.getElementById('process-bulk-btn');
    const tableFilterInput = document.getElementById('table-filter');
    const filterChips = document.querySelectorAll('.filter-chip');

    const STORAGE_KEY = 'ipadComparisons';

    let currentSort = { column: 'value', direction: 'desc' };
    let activeFilterType = 'all'; // all, latest, budget, pro

    let catalog = null; // public/catalog.json — the only data source
    let matcher = null; // IPadMatcher.createMatcher(catalog)

    // --- Initialization ---
    initApp();

    async function initApp() {
        try {
            catalog = await loadCatalog();
            matcher = createMatcher(catalog);
        } catch (error) {
            console.warn('Could not load catalog.json:', error);
            modelSearchInput.disabled = true;
            modelSearchInput.placeholder = "Couldn't load iPad data — reload";
            modelSearchInput.classList.add('load-error');
            return;
        }
        modelSearchInput.disabled = false;
        modelSearchInput.placeholder = "Search by name (e.g. iPad 9) or number (A2602)...";
        if (dataUpdatedEl && catalog.updated) dataUpdatedEl.textContent = catalog.updated;
        loadSavedComparisons();
    }

    async function loadCatalog() {
        const response = await fetch('catalog.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data || !Array.isArray(data.models)) throw new Error('catalog.json has no models');
        return data;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // --- Tab Logic ---
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`${btn.dataset.tab}-tab`).classList.add('active');
        });
    });

    // --- Sorting & Filtering Logic ---
    const sortHeaders = {
        'th-model': 'model',
        'th-price': 'price',
        'th-year': 'released',
        'th-score': 'score',
        'th-value': 'value'
    };

    Object.entries(sortHeaders).forEach(([id, column]) => {
        const th = document.getElementById(id);
        if (th) {
            th.addEventListener('click', () => {
                const isCurrent = currentSort.column === column;
                const newDirection = isCurrent && currentSort.direction === 'desc' ? 'asc' : 'desc';
                currentSort = { column, direction: newDirection };

                document.querySelectorAll('#comparison-table th').forEach(header => {
                    header.classList.remove('sort-asc', 'sort-desc');
                });
                th.classList.add(newDirection === 'asc' ? 'sort-asc' : 'sort-desc');

                updateLeaderboard();
            });
        }
    });

    if (tableFilterInput) {
        tableFilterInput.addEventListener('input', () => applyFilters());
    }

    filterChips.forEach(chip => {
        chip.addEventListener('click', () => {
            filterChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            activeFilterType = chip.dataset.filter;
            applyFilters();
        });
    });

    function applyFilters() {
        const query = tableFilterInput.value.toLowerCase().trim();
        const rows = Array.from(comparisonBody.querySelectorAll('tr'));

        rows.forEach(row => {
            const model = row.dataset.model.toLowerCase();
            const price = parseFloat(row.dataset.price);
            const isLatest = row.dataset.latest === 'true';
            const isPro = model.includes('pro');

            let matchesType = true;
            if (activeFilterType === 'latest') matchesType = isLatest;
            else if (activeFilterType === 'budget') matchesType = price < 400;
            else if (activeFilterType === 'pro') matchesType = isPro;

            const matchesQuery = model.includes(query) || row.dataset.cpu.toLowerCase().includes(query);
            row.style.display = (matchesType && matchesQuery) ? '' : 'none';
        });

        updateLeaderboard(); // Re-sort and re-highlight winner among visible
    }

    // --- Matching helpers ---

    /** {id, candidates} for a query: an id only when the top match is unambiguous. */
    function resolveQuery(query) {
        return resolveMatch(matcher.find(query));
    }

    /** Add a row for a pasted/typed listing: resolved, or "Choose model" when unclear. */
    function addListingRow(text, price, shouldSave = true) {
        const { id, candidates } = resolveQuery(text);
        if (id) return addResultRow({ id, price }, shouldSave);
        return addResultRow({ id: null, model: text || 'Unknown model', price, candidates }, shouldSave);
    }

    // --- Bulk Process Logic (non-Facebook text) ---
    async function processLegacyBulk(rawText) {
        if (!rawText.trim()) return;

        const lines = rawText.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);

        let processedCount = 0;
        let pendingTitle = null;
        let pendingPrice = null;
        let lastAdded = null;

        // Common locations: "Ottawa, ON", "Gatineau, QC", "Clarence-Rockland, ON"
        const junkPatterns = [
            /^[A-Za-z\s\.\-]+, [A-Z]{2}$/, // City, ST location (allow hyphens)
            /^Ships to you/i,
            /^Door pickup/i,
            /^Porch pickup/i,
            /^Local pickup/i,
            /^Seller rating/i,
            /^Condition:/i,
            /^Sold/i,
            /^Pending$/i,
            /^\d+\s+ratings/i,
            /^In stock/i,
            /^Out of stock/i,
            /^Listed/i
        ];
        // Currency (or code) followed by the number: $200, CA$450, CAD 450, $ 200
        const strictPriceRegex = /(?:[\$£€¥]|(?:^|[\s(])(?:CA|CAD|US|USD))\s*?\$?\s*([\d,]+)/i;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (junkPatterns.some(pattern => line.match(pattern))) continue;

            const priceMatch = line.match(strictPriceRegex);
            let price = null;
            let namePart = "";

            if (priceMatch) {
                const rawPrice = priceMatch[1].replace(/,/g, '');
                price = parseInt(rawPrice);

                // "64" followed by "GB" is storage, not a price
                if (line.match(new RegExp(rawPrice + "\\s*GB", "i"))) {
                    price = null;
                } else {
                    const textBeforePrice = line.substring(0, priceMatch.index).trim();
                    if (textBeforePrice.length > 2 && textBeforePrice.toUpperCase().replace(/[^A-Z]/g, '').length > 2) {
                        // Name and price on one line, e.g. "iPad 10 $400"
                        namePart = textBeforePrice;
                        pendingTitle = null;
                        pendingPrice = null;
                    } else if (pendingTitle) {
                        // Title on the previous line
                        namePart = pendingTitle;
                        pendingTitle = null;
                        pendingPrice = null;
                    } else {
                        // Price first; the title should follow
                        if (pendingPrice) {
                            addResultRow({ id: null, model: "Unknown model", price: pendingPrice });
                            processedCount++;
                        }
                        pendingPrice = price;
                        continue;
                    }
                }
            }

            if (!price) {
                // Loose number at the end of the line, e.g. "iPad 10 400"
                const looseNumberMatch = line.match(/(\d+)$/);
                const isStorage = line.match(/\d+\s*(gb|mb|tb)\s*$/i);
                const isGen = line.match(/\d+\s*(st|nd|rd|th)?\s*Gen\s*$/i);

                if (looseNumberMatch && !isStorage && !isGen && parseInt(looseNumberMatch[1]) > 40) {
                    price = parseInt(looseNumberMatch[1]);
                    namePart = line.substring(0, looseNumberMatch.index).trim();
                    if (!namePart && pendingTitle) namePart = pendingTitle;
                    pendingTitle = null;
                    pendingPrice = null;
                } else if (pendingPrice) {
                    namePart = line;
                    price = pendingPrice;
                    pendingPrice = null;
                    pendingTitle = null;
                } else {
                    pendingTitle = line;
                    continue;
                }
            }

            // Clean up the name
            namePart = namePart.replace(/\s+in\s+[A-Za-z\s\.\-]+, [A-Z]{2}$/i, '');
            namePart = namePart.replace(/^Apple\s+/i, '');
            namePart = namePart.replace(/^(Blue|Pink|Silver|Gold|Space Gray|Space Grey)\s+/i, '');
            namePart = namePart.replace(/^(New|Brand New|Like New|Used|Mint)\s+/i, '');
            namePart = namePart.replace(/\b(Blue|Pink|Yellow|Silver|Gold|Space Gray|Grey|White|Black)\b/gi, '');
            namePart = namePart.trim();

            if (!price) continue;
            if (!namePart) namePart = "Unknown model";

            const { id, candidates } = resolveQuery(namePart);
            const key = id || namePart;

            // Same model as the row just added: a crossed-out price. Keep the lower one.
            if (lastAdded && lastAdded.key === key) {
                if (price < lastAdded.price) {
                    if (lastAdded.row) lastAdded.row.remove();
                    processedCount--;
                } else {
                    pendingTitle = "";
                    continue;
                }
            }

            const addedRow = id
                ? addResultRow({ id, price })
                : addResultRow({ id: null, model: namePart, price, candidates });

            lastAdded = { key, price, row: addedRow };
            processedCount++;
            pendingTitle = ""; // don't reuse the title for a following crossed-out price
        }

        if (pendingPrice) {
            addResultRow({ id: null, model: "Unknown model", price: pendingPrice });
            processedCount++;
        }

        if (processedCount === 0) {
            alert('Could not find any valid listings. Try copying closer to the "Title... Price" area.');
        } else {
            resultContainer.scrollIntoView({ behavior: 'smooth' });
        }
        updateLeaderboard();
        checkEmptyTable();
        saveComparisons();
    }

    processBulkBtn.addEventListener('click', async () => {
        if (!matcher) return;
        const rawText = bulkInput.value;
        if (!rawText.trim()) return;

        // Try the Facebook block parser first
        const blocks = parseFacebookBlocks(rawText);

        if (blocks === null) {
            await processLegacyBulk(rawText);
            return;
        }

        let processedCount = 0;

        for (const block of blocks) {
            if (!isIPadListing(block.rawTitle)) continue;
            const cleaned = cleanTitle(block.rawTitle);
            addListingRow(cleaned || block.rawTitle, block.price);
            processedCount++;
        }

        if (processedCount === 0) {
            alert('No iPad listings found in the pasted text. Make sure you\'re copying from Facebook Marketplace search results.');
        }

        updateLeaderboard();
        checkEmptyTable();
    });

    // --- Search Logic ---
    modelSearchInput.addEventListener('input', (e) => {
        selectedModelIdInput.value = ''; // typing again invalidates an earlier pick
        const query = e.target.value.trim();
        if (query.length < 1 || !matcher) {
            searchResults.classList.add('hidden');
            return;
        }
        renderResults(matcher.find(query), query);
    });

    // Hide results when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            searchResults.classList.add('hidden');
        }
        // Row model pickers: close any not containing the click
        document.querySelectorAll('.model-resolve-wrapper .suggestions-dropdown').forEach(list => {
            if (!list.parentElement.contains(e.target)) list.classList.add('hidden');
        });
    });

    /** HTML for one suggestion: bold A-number, or a chip/year badge for those match types. */
    function suggestionHtml(match, query) {
        const m = matcher.get(match.id);
        if (match.matchType === 'number') {
            const a = (String(query).toUpperCase().match(/\bA\d{4}\b/) || [''])[0];
            return `<span><strong>${escapeHtml(a)}</strong> - ${escapeHtml(match.name)}</span>`;
        }
        let extra = '';
        if (match.matchType === 'cpu' && m) {
            extra = ` <span class="badge chip-badge matched-badge">${escapeHtml(m.chip)}</span>`;
        } else if (match.matchType === 'year' && m) {
            extra = ` <span class="badge year-badge matched-badge">${escapeHtml(m.released)}</span>`;
        }
        return `<span>${escapeHtml(match.name)}</span>${extra}`;
    }

    function renderResults(matches, query) {
        searchResults.innerHTML = '';

        // Part Number (e.g. MR7F2CL/A) instead of an A-number
        const q = query.toLowerCase();
        const potentialMPN = /^[mnfp][a-z0-9]{3,}.*/.test(q) && !q.includes('ipad') && matches.length === 0;

        if (matches.length === 0) {
            if (potentialMPN) {
                const li = document.createElement('li');
                li.className = 'no-result-tip';
                li.innerHTML = `
                    <div style="line-height: 1.4; color: #fbbf24;">
                        <strong>Part Number Detected</strong><br>
                        <span style="font-size: 0.85em; color: var(--text-muted)">
                            Settings shows the Part Number (e.g. ${escapeHtml(query)}).<br>
                            <strong>Tap it once</strong> in Settings to reveal the "A" Model Number (e.g. A1893), then search for that!
                        </span>
                    </div>
                 `;
                searchResults.appendChild(li);
                searchResults.classList.remove('hidden');
                return;
            }
            searchResults.classList.add('hidden');
            return;
        }

        // Ambiguous results are listed normally: the click is the user's choice.
        matches.forEach(match => {
            const li = document.createElement('li');
            li.innerHTML = suggestionHtml(match, query);
            li.dataset.id = match.id;
            li.addEventListener('click', () => selectModel(match.id));
            searchResults.appendChild(li);
        });
        searchResults.classList.remove('hidden');
    }

    function selectModel(id) {
        const m = matcher.get(id);
        if (!m) return;
        modelSearchInput.value = m.name;
        selectedModelIdInput.value = id;
        searchResults.classList.add('hidden');
    }

    // --- Calculation Logic ---
    calculateBtn.addEventListener('click', () => {
        calculateBtn.classList.add('button-click');
        setTimeout(() => calculateBtn.classList.remove('button-click'), 300);
        if (!matcher) return;

        let id = selectedModelIdInput.value;
        const query = modelSearchInput.value.trim();

        // No click on a suggestion: accept the top match only if it's unambiguous.
        if (!matcher.get(id) && query) id = resolveQuery(query).id;

        const price = parseFloat(priceInput.value);

        if (!id) {
            alert("Could not identify a specific iPad model. Please select one from the list.");
            return;
        }
        if (!price || price <= 0) {
            alert("Please enter a valid price.");
            return;
        }

        addResultRow({ id, price });

        modelSearchInput.value = '';
        selectedModelIdInput.value = '';
        priceInput.value = '';
        modelSearchInput.focus();
    });

    /**
     * Attach a model picker (input + suggestions) inside `container`.
     * Shows `candidates` (catalog ids) while the input still holds `initialText`,
     * live find() results once the user types. Calls onPick(id).
     */
    function attachModelPicker(container, { initialText, placeholder, candidates = [], onPick, autofocus = false }) {
        container.innerHTML = `
            <div class="model-resolve-wrapper">
                <input type="text" class="model-resolve-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off">
                <ul class="suggestions-dropdown hidden"></ul>
            </div>`;
        const input = container.querySelector('.model-resolve-input');
        const list = container.querySelector('.suggestions-dropdown');
        input.value = initialText;

        const currentOptions = () => {
            const q = input.value.trim();
            if (candidates.length && q === initialText.trim()) {
                return candidates.map(id => matcher.get(id)).filter(Boolean)
                    .map(m => ({ id: m.id, name: m.name, matchType: 'name' }));
            }
            return q ? matcher.find(q) : [];
        };

        const show = () => {
            const options = currentOptions();
            list.innerHTML = '';
            if (options.length === 0) {
                list.classList.add('hidden');
                return;
            }
            options.forEach(match => {
                const li = document.createElement('li');
                li.innerHTML = suggestionHtml(match, input.value);
                li.dataset.id = match.id;
                li.addEventListener('click', (e) => {
                    e.stopPropagation();
                    list.classList.add('hidden');
                    onPick(match.id);
                });
                list.appendChild(li);
            });
            list.classList.remove('hidden');
        };

        input.addEventListener('input', show);
        input.addEventListener('focus', show);
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            // Enter picks only an unambiguous match
            const { id } = resolveQuery(input.value.trim());
            if (id) onPick(id);
            else show();
        });
        if (autofocus) input.focus();
        return input;
    }

    /** Score cell content for a catalog model. */
    function scoreCellHtml(m) {
        if (m.score_status === 'pending') return '<span class="score-note">Score pending</span>';
        if (m.score_status !== 'ok' || !m.score) return '<span class="score-note">No GB6 score (too old)</span>';
        const badge = m.score.source === 'gb7-converted'
            ? ' <span class="estimate-badge" title="Estimated from Geekbench 7">≈</span>'
            : '';
        return `${m.score.gb6_multi}${badge}`;
    }

    /**
     * Add a comparison row.
     * entry: {id, price} for a catalog model, or {id: null, model, price, candidates}
     * for a listing that still needs a model. Score/value come from the catalog at render.
     */
    function addResultRow(entry, shouldSave = true) {
        const price = Number(entry.price);
        const m = entry.id ? matcher.get(entry.id) : null;
        const modelText = m ? m.name : (entry.model || 'Unknown model');
        const candidates = m ? [] : (entry.candidates || []);

        // Skip an exact duplicate (same model + price)
        const isDuplicate = Array.from(comparisonBody.querySelectorAll('tr')).some(row =>
            (row.dataset.id || '') === (m ? m.id : '') &&
            row.dataset.model === modelText &&
            parseFloat(row.dataset.price) === price);
        if (isDuplicate) return null;

        const value = valueOf(m, price);

        const row = document.createElement('tr');
        row.dataset.id = m ? m.id : '';
        row.dataset.model = modelText;
        row.dataset.price = price;
        row.dataset.value = value == null ? '' : value;
        row.dataset.score = (m && m.score_status === 'ok' && m.score) ? m.score.gb6_multi : '';
        row.dataset.cpu = m ? m.chip : '';
        row.dataset.released = m ? m.released : '';
        row.dataset.latest = String(!!m && m.max_os_major >= catalog.latest_ipados);
        row.dataset.status = m ? m.score_status : 'unknown';

        if (!m) {
            row.classList.add('incomplete-row');
            const ambiguous = candidates.length > 0;
            row.innerHTML = `
                <td class="model-cell"></td>
                <td class="price-cell">$${price}</td>
                <td colspan="3"><span class="needs-info-badge">${ambiguous
                    ? 'Choose model: this listing fits more than one iPad'
                    : 'Identify this model to see its value score'}</span></td>
                <td>?</td>
                <td class="value-cell">
                    <span class="score-val" style="font-size: 0.9em; color: var(--text-muted)">${ambiguous ? 'Choose model' : 'Unknown model'}</span>
                </td>
                <td><button class="delete-btn" aria-label="Remove row">×</button></td>
            `;
            attachModelPicker(row.querySelector('.model-cell'), {
                initialText: modelText,
                placeholder: 'Type to search definition...',
                candidates,
                onPick: (id) => replaceRowModel(row, id),
            });
        } else {
            row.innerHTML = `
                <td class="model-name clickable" title="Click to edit model">${escapeHtml(m.name)}</td>
                <td class="price-cell clickable" title="Click to edit price">$${price}</td>
                <td><span class="badge chip-badge">${escapeHtml(m.chip)}</span></td>
                <td>${m.released}</td>
                <td>${escapeHtml(displayMaxOS(m, catalog.latest_ipados))}</td>
                <td class="score-cell">${scoreCellHtml(m)}</td>
                <td class="value-cell">
                    <span class="score-val">${value == null ? '—' : value.toFixed(2)}</span>
                    <span class="trophy-icon"></span>
                </td>
                <td><button class="delete-btn" aria-label="Remove row">×</button></td>
            `;

            // Click the model name to pick another model
            const modelCell = row.querySelector('.model-name');
            modelCell.addEventListener('click', () => {
                if (modelCell.querySelector('input')) return; // already editing
                modelCell.classList.remove('clickable');
                attachModelPicker(modelCell, {
                    initialText: m.name,
                    placeholder: 'Type to search...',
                    onPick: (id) => replaceRowModel(row, id),
                    autofocus: true,
                });
            });

            row.classList.add(row.dataset.latest === 'true' ? 'max-ios-latest' : 'max-ios-outdated');
        }

        if (shouldSave) row.classList.add('new-row');

        row.querySelector('.delete-btn').addEventListener('click', () => {
            row.remove();
            checkEmptyTable();
            updateLeaderboard();
            saveComparisons();
        });

        // Click the price to edit it
        const priceCell = row.querySelector('.price-cell');
        priceCell.addEventListener('click', () => {
            if (priceCell.querySelector('input')) return;

            const currentPrice = row.dataset.price;
            priceCell.innerHTML = `<input type="number" class="price-edit-input" value="${escapeHtml(currentPrice)}" min="1" step="1">`;
            const input = priceCell.querySelector('input');
            input.focus();

            function saveNewPrice() {
                const newPrice = parseFloat(input.value);
                if (!newPrice || newPrice <= 0) {
                    priceCell.innerHTML = `$${currentPrice}`;
                    return;
                }
                row.dataset.price = newPrice;
                const newValue = valueOf(matcher.get(row.dataset.id), newPrice);
                row.dataset.value = newValue == null ? '' : newValue;
                priceCell.innerHTML = `$${newPrice}`;
                const valEl = row.querySelector('.score-val');
                if (m && valEl) valEl.textContent = newValue == null ? '—' : newValue.toFixed(2);

                updateLeaderboard();
                saveComparisons();
            }

            input.addEventListener('blur', saveNewPrice);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') input.blur();
            });
        });

        comparisonBody.appendChild(row);
        checkEmptyTable();
        applyFilters();

        if (shouldSave) saveComparisons();

        return row;
    }

    /** Swap a row's model, keeping its (possibly edited) price. */
    function replaceRowModel(row, id) {
        const price = parseFloat(row.dataset.price);
        row.remove();
        addResultRow({ id, price });
        applyFilters();
        saveComparisons();
    }

    // Sorts table by currentSort and highlights the best value among visible rows.
    // Rows without a value (pending, too old, unknown) sort last and are never best.
    function updateLeaderboard() {
        const rows = Array.from(comparisonBody.querySelectorAll('tr'));
        if (rows.length === 0) return;

        const num = (s) => (s === '' || s == null ? null : parseFloat(s));
        const items = rows.map(row => ({
            row,
            model: row.dataset.model,
            price: num(row.dataset.price),
            released: num(row.dataset.released),
            score: num(row.dataset.score),
            value: num(row.dataset.value),
        }));

        const sorted = rankRows(items, currentSort.column, currentSort.direction);
        sorted.forEach(it => comparisonBody.appendChild(it.row));

        rows.forEach(row => {
            row.classList.remove('champion-row');
            const trophy = row.querySelector('.trophy-icon');
            if (trophy) trophy.textContent = '';
        });

        const best = pickBest(items.filter(it => it.row.style.display !== 'none'));
        if (best) {
            best.row.classList.add('champion-row');
            const trophy = best.row.querySelector('.trophy-icon');
            if (trophy) trophy.textContent = ' 🏆';
        }
    }

    // "Clear All" Logic
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            comparisonBody.innerHTML = '';
            checkEmptyTable();
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (err) {
                console.warn('Could not clear saved rows', err);
            }
        });
    }

    // --- Persistence ---
    // Only {id, model, price} is stored; scores and values come from the catalog on load.
    function saveComparisons() {
        const data = Array.from(comparisonBody.querySelectorAll('tr')).map(row => ({
            id: row.dataset.id || null,
            model: row.dataset.model,
            price: parseFloat(row.dataset.price),
        }));
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (err) {
            console.warn('Could not save rows', err);
        }
    }

    function loadSavedComparisons() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (e) {
            console.warn('Ignoring unreadable saved rows', e);
        }
        migrateSaved(saved, matcher).forEach(entry => addResultRow(entry, false));
        updateLeaderboard();
        checkEmptyTable();
        if (saved) saveComparisons(); // write back in the new format
    }

    function checkEmptyTable() {
        const instructions = document.getElementById('instructions');
        const empty = comparisonBody.children.length === 0;
        resultContainer.classList.toggle('hidden', empty);
        if (clearAllBtn) clearAllBtn.classList.toggle('hidden', empty);
        if (instructions) instructions.classList.toggle('hidden', !empty);
    }
});
