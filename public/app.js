document.addEventListener('DOMContentLoaded', () => {
    const modelSearchInput = document.getElementById('model-search');
    const searchResults = document.getElementById('suggestions');
    const priceInput = document.getElementById('price-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const selectedModelIdInput = document.getElementById('selected-model-id');
    const resultContainer = document.getElementById('result-container');
    const comparisonBody = document.getElementById('comparison-body');
    const clearAllBtn = document.getElementById('clear-all-btn');

    // Tab Elements
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const bulkInput = document.getElementById('bulk-input');
    const processBulkBtn = document.getElementById('process-bulk-btn');
    const tableFilterInput = document.getElementById('table-filter');
    const filterChips = document.querySelectorAll('.filter-chip');

    let currentSort = { column: 'value', direction: 'desc' };
    let activeFilterType = 'all'; // all, latest, budget, pro

    let db;
    let modelsData = {}; // Key: Model Name, Value: { score, cpu, released }
    let modelMapping = []; // Array of {model_name, model_numbers}

    // --- Initialization ---
    try {
        // Explicit Config
        const firebaseConfig = {
            apiKey: "AIzaSyDrwNG77jo8CSyLRbYYIfL-SnOh7ZAje0c",
            authDomain: "ipad-compare.firebaseapp.com",
            projectId: "ipad-compare",
            storageBucket: "ipad-compare.firebasestorage.app",
            messagingSenderId: "377670593306",
            appId: "1:377670593306:web:da241adefe267354bb1aa3",
            measurementId: "G-RN1C0TJG6Y"
        };
        firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        console.log("Firebase initialized");
        initApp();
    } catch (e) {
        console.error("Firebase init error", e);
        modelSearchInput.placeholder = `Init Error: ${e.message}`;
    }

    async function initApp() {
        try {
            await Promise.all([loadModels(), loadMapping()]);
            console.log("Data loaded. Enabling input...");
            modelSearchInput.removeAttribute('disabled');
            modelSearchInput.disabled = false; // Double tap
            modelSearchInput.placeholder = "Search by name (e.g. iPad 9) or number (A2602)...";
            loadSavedComparisons(); // Load from localStorage on init
        } catch (error) {
            console.error("Error initializing app:", error);
            modelSearchInput.placeholder = `Error: ${error.message}`;
            // Try to enable anyway so they can search if partial data loaded?
            // modelSearchInput.removeAttribute('disabled');
        }
    }

    async function loadModels() {
        try {
            const snapshot = await db.collection('geekbench_scores').get();
            if (snapshot.empty) {
                console.warn("No models found in DB");
            } else {
                snapshot.forEach(doc => {
                    const data = doc.data();
                    modelsData[data.name || doc.id] = {
                        score: data.multi_core_score || 0,
                        cpu: data.cpu || 'Unknown',
                        released: data.released || 'Unknown',
                        max_os: data.max_os || 'Unknown'
                    };
                });
            }

            // Fallback: Load local model_specs.json to fill gaps (e.g. scores missing in DB)
            try {
                const specsResponse = await fetch('model_specs.json');
                if (specsResponse.ok) {
                    const specs = await specsResponse.json();
                    for (const [name, data] of Object.entries(specs)) {
                        if (!modelsData[name]) {
                            // Totally missing from DB -> Add it
                            modelsData[name] = {
                                score: data.score || 0,
                                cpu: data.cpu || 'Unknown',
                                released: data.released || 'Unknown',
                                max_os: data.max_os || 'Unknown'
                            };
                        } else {
                            // Exists in DB, but might have missing data
                            const current = modelsData[name];

                            // Patch Score
                            if ((!current.score || current.score === 0) && data.score) {
                                console.log(`Patching score for ${name} from local specs: ${data.score}`);
                                current.score = data.score;
                            }
                            // Patch CPU
                            if ((!current.cpu || current.cpu === 'Unknown') && data.cpu) {
                                current.cpu = data.cpu;
                            }
                            // Patch Released
                            if ((!current.released || current.released === 'Unknown') && data.released) {
                                current.released = data.released;
                            }
                            // Patch Max iOS
                            if ((!current.max_os || current.max_os === 'Unknown') && data.max_os) {
                                current.max_os = data.max_os;
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn("Could not load model_specs.json for fallback", err);
            }
        } catch (error) {
            throw new Error(`DB Load Failed: ${error.message}`);
        }
    }

    async function loadMapping() {
        try {
            const response = await fetch('model_mapping.json');
            if (!response.ok) throw new Error("Mapping file not found");
            modelMapping = await response.json();
        } catch (error) {
            console.error("Error loading mapping:", error);
        }
    }


    // --- Tab Logic ---
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Deactivate all
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Activate clicked
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            document.getElementById(`${tabId}-tab`).classList.add('active');
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

                // Update UI Header classes
                document.querySelectorAll('#comparison-table th').forEach(header => {
                    header.classList.remove('sort-asc', 'sort-desc');
                });
                th.classList.add(newDirection === 'asc' ? 'sort-asc' : 'sort-desc');

                updateLeaderboard();
            });
        }
    });

    if (tableFilterInput) {
        tableFilterInput.addEventListener('input', () => {
            applyFilters();
        });
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
            const isLatest = row.dataset.max_os === 'Latest';
            const isPro = model.includes('pro');

            let matchesType = true;
            if (activeFilterType === 'latest') matchesType = isLatest;
            else if (activeFilterType === 'budget') matchesType = price < 400;
            else if (activeFilterType === 'pro') matchesType = isPro;

            const matchesQuery = model.includes(query) || row.dataset.cpu.toLowerCase().includes(query);

            if (matchesType && matchesQuery) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });

        updateLeaderboard(); // Re-sort and re-highlight winner among visible
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

    // --- Bulk Process Logic (Improved) ---
    async function processLegacyBulk(rawText) {
        console.log("Bulk Process Started. Input length:", rawText.length);
        if (!rawText.trim()) return;

        const lines = rawText.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l.length > 0);
        console.log("Lines to process:", lines.length);

        let processedCount = 0;
        let pendingTitle = null;
        let pendingPrice = null;
        let lastAdded = null;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            console.log(`Processing Line [${i}]: "${line}"`);

            // 1. Skip obvious junk lines 
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

            const isJunk = junkPatterns.some(pattern => line.match(pattern));
            if (isJunk) {
                console.log("  -> Junk Detected");
                continue;
            }

            // 2. Identify Price
            // PARANOID REGEX V4: Avoid \b ambiguity completely.
            // Require currency code to be at Start of line OR preceded by whitespace.
            // Require currency code to be followed by End of line OR whitespace OR digit OR dollar sign.
            // Matches: "CA$450", " CA 450", "US$500", "USD 500"
            // Ignored: "case" (preceded by space, but followed by 's' -> fails lookahead)
            // Ignored: "ACAD" (preceded by A -> fails start check)
            const priceRegex = /[\$£€¥]|(?:^|[\s(])(?:CA|CAD|US|USD)(?=$|[\s)\d\$])|\$\s*\d/i;
            // Improved Regex: Capture the numeric value associated with the currency
            // Matches: $200, CA$450, CAD 450, $ 200
            const strictPriceRegex = /(?:[\$£€¥]|(?:^|[\s(])(?:CA|CAD|US|USD))\s*?\$?\s*([\d,]+)/i;
            const priceMatch = line.match(strictPriceRegex);

            let price = null;
            let namePart = "";

            if (priceMatch) {
                const rawPrice = priceMatch[1].replace(/,/g, '');
                price = parseInt(rawPrice);

                // Validate: If the number is identical to "64" and line contains "GB", abort price
                if (line.match(new RegExp(rawPrice + "\\s*GB", "i"))) {
                    console.log("  -> Aborting price, looked like storage size");
                    price = null;
                } else {
                    const textBeforePrice = line.substring(0, priceMatch.index).trim();
                    // Heuristic Name Cleaning
                    // 1. Check for Embedded Name (e.g. "iPad 10 $400")
                    if (textBeforePrice.length > 2 && textBeforePrice.toUpperCase().replace(/[^A-Z]/g, '').length > 2) {
                        namePart = textBeforePrice;
                        pendingTitle = null;
                        pendingPrice = null;
                        console.log("  -> Name extracted from prefix:", namePart);
                    }
                    // 2. Check for Pending Title (Title First Case)
                    else if (pendingTitle) {
                        namePart = pendingTitle;
                        pendingTitle = null;
                        pendingPrice = null;
                        console.log("  -> Name extracted from pendingTitle:", namePart);
                    }
                    // 3. Store as Pending Price (Price First Case)
                    else {
                        if (pendingPrice) {
                            // Flush existing pendingPrice as Unknown (Logic happens in loop end or by processing next line here?)
                            // Actually, let's just commit it here as Unknown to clear the buffer?
                            // No, let's stick to the flow: set pendingPrice.
                            // But what if we overwrite? Let's commit the old one.
                            console.log("  -> Overwriting orphan pending price, committing old one as Unknown");
                            addResultRow({ model: "Unknown Model", price: pendingPrice, incomplete: true }, true);
                        }
                        console.log(`  -> Storing Pending Price: $${price}`);
                        pendingPrice = price;
                        continue; // Skip processing this line further, waiting for next line (title)
                    }
                }
            }

            if (!price) {
                // Fallback to Loose Number logic (Only if NO strict price found)
                const looseNumberMatch = line.match(/(\d+)$/);
                const isStorage = line.match(/\d+\s*(gb|mb|tb)\s*$/i);
                const isGen = line.match(/\d+\s*(st|nd|rd|th)?\s*Gen\s*$/i);

                if (looseNumberMatch && !isStorage && !isGen && parseInt(looseNumberMatch[1]) > 40) {
                    price = parseInt(looseNumberMatch[1]);
                    namePart = line.substring(0, looseNumberMatch.index).trim();
                    // Loose number logic usually implies Self-Contained line (Name Part + Number at end)
                    // So we treat it as found.
                    pendingTitle = null;
                    pendingPrice = null;
                    if (!namePart && pendingTitle) {
                        // This case (Title on prev line, number on this line)
                        // Actually looseNumberMatch usually means "iPad 10 400".
                        // If Line is just "400", namePart is empty.
                        if (pendingTitle) {
                            namePart = pendingTitle;
                            pendingTitle = null;
                        } else {
                            namePart = "Unknown Model";
                        }
                    }
                    console.log("  -> Loose number price found:", price);
                } else {
                    // No price found at all
                    // 1. Check for Pending Price (Price First Case)
                    if (pendingPrice) {
                        namePart = line;
                        price = pendingPrice;
                        pendingPrice = null;
                        pendingTitle = null;
                        console.log(`  -> Matched with Pending Price: $${price}`);
                    }
                    // 2. Store as Pending Title (Title First Case)
                    else {
                        console.log("  -> No price found. Setting pendingTitle:", line);
                        pendingTitle = line;
                        continue; // Skip match logic
                    }
                }
            }

            // Clean up Name Part
            // 1. Remove "in City, ST" location suffix
            namePart = namePart.replace(/\s+in\s+[A-Za-z\s\.\-]+, [A-Z]{2}$/i, '');
            // 2. Remove common prefixes that confuse matcher if not exact
            // e.g. "Apple iPad..." -> "iPad..." (Matcher works better with standard starts)
            namePart = namePart.replace(/^Apple\s+/i, '');
            // 3. Remove "Blue", "Silver", "Space Gray", "Gold" colors if at start
            namePart = namePart.replace(/^(Blue|Pink|Silver|Gold|Space Gray|Space Grey)\s+/i, '');
            // Remove descriptors
            namePart = namePart.replace(/^(New|Brand New|Like New|Used|Mint)\s+/i, '');
            // Remove colors roughly (heuristic)
            namePart = namePart.replace(/\b(Blue|Pink|Yellow|Silver|Gold|Space Gray|Grey|White|Black)\b/gi, '');
            namePart = namePart.trim();

            if (!price) continue;
            if (!namePart) namePart = "Unknown Model";

            console.log(`  -> ADDING ROW: ${namePart} - $${price}`);

            // 3. Find Match & Add Row
            const matches = findMatches(namePart);

            let modelNameToAdd = namePart;
            let modelDataToAdd = null;

            if (matches.length > 0) {
                // Exact or fuzzy match found
                const match = matches[0];
                modelNameToAdd = match.name;
                modelDataToAdd = modelsData[match.name];
            }

            // --- Deduplication Check (Sequential) ---
            // If the current item has the SAME NAME (normalized) as the LAST item added,
            // we assume it's a "crossed out price" duplicate.
            // We keep the one with the LOWER PRICE.

            let isDuplicateOfLast = false;

            if (lastAdded && lastAdded.name === modelNameToAdd) {
                isDuplicateOfLast = true;
                console.log(`  -> Potential Duplicate of Last Item: "${modelNameToAdd}"`);

                if (price < lastAdded.price) {
                    // NEW price is LOWER (Better). Replace the old one.
                    console.log(`    -> New Price ($${price}) is LOWER than Old Price ($${lastAdded.price}). REPLACING.`);

                    // Remove the DOM element of the previous row
                    if (lastAdded.row) {
                        lastAdded.row.remove();
                    }
                    // Continue to add the NEW row below...
                    processedCount--; // Decrement count since we removed one
                } else {
                    // NEW price is HIGHER (Worse). IGNORE this new row.
                    console.log(`    -> New Price ($${price}) is HIGHER/EQUAL to Old Price ($${lastAdded.price}). IGNORING.`);
                    pendingTitle = ""; // Clear pending title
                    continue; // Skip adding
                }
            }

            // Add the Row
            let addedRow;
            if (modelDataToAdd) {
                addedRow = addResultRow({
                    model: modelNameToAdd,
                    price: price,
                    cpu: modelDataToAdd ? modelDataToAdd.cpu : '?',
                    released: modelDataToAdd ? modelDataToAdd.released : '?',
                    max_os: modelDataToAdd ? modelDataToAdd.max_os : '?',
                    score: modelDataToAdd ? modelDataToAdd.score : 0
                }, true);
            } else {
                addedRow = addResultRow({
                    model: modelNameToAdd,
                    price: price,
                    incomplete: true
                }, true);
            }

            // Update Last Added
            lastAdded = {
                name: modelNameToAdd,
                price: price,
                row: addedRow
            };

            processedCount++;

            // Clear pendingTitle so it's not reused for subsequent prices (e.g. crossed out prices)
            pendingTitle = "";
        }

        // Flush leftover Pending Price
        if (pendingPrice) {
            console.log("  -> Flushing leftover pending price");
            addResultRow({
                model: "Unknown Model",
                price: pendingPrice,
                incomplete: true
            }, true);
            processedCount++;
        }

        console.log("Total Processed Rows:", processedCount);

        if (processedCount === 0) {
            alert('Could not find any valid listings. Try copying closer to the "Title... Price" area. Check console for details.');
        } else {
            // Scroll to results
            document.querySelector('.results-section').scrollIntoView({ behavior: 'smooth' });
        }
        updateLeaderboard();
        checkEmptyTable();
    }

    processBulkBtn.addEventListener('click', async () => {
        const rawText = bulkInput.value;
        if (!rawText.trim()) return;

        // Try Facebook block parser first
        const blocks = parseFacebookBlocks(rawText);

        if (blocks === null) {
            // Not a Facebook paste — use legacy parser
            console.log("No Facebook block structure detected, using legacy parser");
            await processLegacyBulk(rawText);
            return;
        }

        console.log(`Facebook parser: found ${blocks.length} listing blocks`);

        let processedCount = 0;

        for (const block of blocks) {
            // Pre-filter: skip non-iPad listings
            if (!isIPadListing(block.rawTitle)) {
                console.log(`Skipping non-iPad listing: "${block.rawTitle}"`);
                continue;
            }

            // Clean title for matching
            const cleaned = cleanTitle(block.rawTitle);
            console.log(`Block: "${block.rawTitle}" -> cleaned: "${cleaned}" @ $${block.price}`);

            // Find model match
            const matches = findMatches(cleaned);

            if (matches.length > 0) {
                const match = matches[0];
                const data = modelsData[match.name];
                addResultRow({
                    model: match.name,
                    price: block.price,
                    cpu: data ? data.cpu : '?',
                    released: data ? data.released : '?',
                    max_os: data ? data.max_os : '?',
                    score: data ? data.score : 0
                }, true);
            } else {
                // Unknown model — show with resolve prompt
                addResultRow({
                    model: cleaned || block.rawTitle,
                    price: block.price,
                    incomplete: true
                }, true);
            }

            processedCount++;
        }

        console.log(`Facebook parser: processed ${processedCount} iPad listings`);

        if (processedCount === 0) {
            alert('No iPad listings found in the pasted text. Make sure you\'re copying from Facebook Marketplace search results.');
        }

        updateLeaderboard();
        checkEmptyTable();
    });

    // --- Search Logic ---
    modelSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (query.length < 1) {
            searchResults.classList.add('hidden');
            return;
        }

        const matches = findMatches(query);
        renderResults(matches);
    });

    // Hide results when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            searchResults.classList.add('hidden');
        }
    });

    function findMatches(query) {
        // Tokenize Query (Lowercase for matching)
        const queryLower = query.toLowerCase();

        // 0. BLOCK GENERIC "iPad" / "Apple iPad"
        // If the query is just "ipad" or "apple ipad", it's too generic to map to a specific generation.
        // Return empty so it shows as "Unknown" (user sees the raw text), rather than guessing "10th Gen".
        const cleanQuery = queryLower.replace(/^apple\s+/, '').trim();
        if (cleanQuery === 'ipad') return [];

        const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 0);
        if (queryTokens.length === 0) return [];

        // --- ENFORCE PRODUCT LINE MATCHING ---
        // If the user explicitly types "mini", "air", or "pro", we MUST match those families.
        const hasMini = queryLower.includes('mini');
        const hasAir = queryLower.includes('air');
        const hasPro = queryLower.includes('pro');

        let scoredResults = [];
        const availableModels = Object.keys(modelsData);

        // Check for MPN Pattern (Marketing Part Number) e.g. MR7F2CL/A
        const mpnPattern = /^[mnfp][a-z0-9]{3,}/i;
        const isPotentialMPN = mpnPattern.test(query) && !query.includes('ipad');

        // Check for Explicit Screen Size in Query (e.g. "12.9", "11-inch")
        const screenSizeMatch = queryLower.match(/(\d+(\.\d)?)\s*(-?inch|")/);
        const queryScreenSize = screenSizeMatch ? parseFloat(screenSizeMatch[1]) : null;

        // Deduplication Map: Key = Canonical Name, Value = Result Object
        const uniqueResults = new Map();

        availableModels.forEach(modelName => {
            // FILTER: Skip OS versions (e.g., "iPadOS 15.x", "iOS 12.x")
            if (/^(iPadOS|iOS)\s/i.test(modelName)) return;

            const modelLower = modelName.toLowerCase();

            // --- PRODUCT LINE FILTER (POSITIVE & NEGATIVE) ---
            // 1. Positive: If query has "mini", model MUST have "mini".
            if (hasMini && !modelLower.includes('mini')) return;
            if (hasAir && !modelLower.includes('air')) return;
            if (hasPro && !modelLower.includes('pro')) return;

            // 2. Negative: If query does NOT have "mini", but model IS "mini", PENALIZE.
            //    If query does NOT have "air", but model IS "air", PENALIZE.
            //    If query does NOT have "pro", but model IS "pro", PENALIZE.
            // Exceptions: 
            // - MPN/Model Number matches (A1234) should bypass this penalty as they are specific.
            // - We apply this penalty to the score later, or return early if we want strictness.
            // Let's apply a massive score penalty so it only wins if it's the ONLY mostly-valid option (unlikely)
            // or if it has an exact A-number match (which we give +200).

            let isNegativeMatch = false;
            if (!hasMini && modelLower.includes('mini')) isNegativeMatch = true;
            if (!hasAir && modelLower.includes('air')) isNegativeMatch = true;
            if (!hasPro && modelLower.includes('pro')) isNegativeMatch = true;

            let matchScore = 0;
            // Apply penalty initially? No, let's subtract at end.

            let matchType = 'fuzzy';
            let matchedDetail = null;

            // 1. Exact Name Substring (Highest Relevance)
            if (modelLower.includes(query)) {
                matchScore += 100;
                matchType = 'name';
            }

            // 2. Token Matching
            let tokenMatches = 0;
            queryTokens.forEach(token => {
                // STRICT NUMERIC MATCHING
                // If token contains a digit (e.g. "3", "11"), ensure it's not part of another number (e.g. "13", "11-inch")
                // Exception: "3" matches "3rd" (starts with 3, next char non-digit)
                // Exception: "11" matches "11-inch" (starts with 11, next char non-digit)
                // Rule: Must be preceded by non-digit (or start) AND followed by non-digit (or end).
                if (/\d/.test(token)) {
                    // Escape special regex chars in token just in case
                    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    // Look for token bounded by non-digits
                    const regex = new RegExp(`(?:^|[^0-9])${escapedToken}(?:[^0-9]|$)`, 'i');
                    if (regex.test(modelLower)) {
                        tokenMatches++;
                    }
                } else {
                    // Text tokens (e.g. "air", "pro") - standard includes is fine
                    if (modelLower.includes(token)) {
                        tokenMatches++;
                    }
                }
            });
            matchScore += (tokenMatches * 10);

            // SPECIAL: Screen Size Boost
            if (queryScreenSize) {
                // Check if model name contains this size
                // e.g. "12.9"
                if (modelLower.includes(queryScreenSize.toString())) {
                    matchScore += 150; // Huge Boost for matching screen size
                }
            }

            // 3. A-Number Matching (Check Mapping)
            let canonicalName = modelName; // Default to self
            let isCanonical = false;

            const mapping = modelMapping.find(m => {
                if (m.model_name === modelName) return true;
                if (m.aliases && m.aliases.includes(modelName)) return true;
                const mappingNorm = m.model_name.replace(/[()]/g, '').toLowerCase();
                const modelNorm = modelName.replace(/[()]/g, '').toLowerCase();
                if (mappingNorm.includes(modelNorm) && /\d/.test(modelName)) return true;
                return false;
            });

            if (mapping) {
                // Use the official long name as key to grouping
                canonicalName = mapping.model_name;
                if (mapping.model_name === modelName) isCanonical = true;

                if (mapping.model_numbers) {
                    const exactNumMatch = mapping.model_numbers.find(num => num.toLowerCase() === query);
                    const partialNumMatch = mapping.model_numbers.find(num => num.toLowerCase().includes(query));

                    // NEW: Reverse Check - Does the QUERY contain the Model Number?
                    const queryContainsNum = mapping.model_numbers.find(num => {
                        const n = num.toLowerCase();
                        if (queryTokens.includes(n)) return true;
                        if (n.length > 3 && query.includes(n)) return true;
                        return false;
                    });

                    if (exactNumMatch) {
                        matchScore += 200;
                        matchType = 'number';
                        matchedDetail = exactNumMatch;
                    } else if (queryContainsNum) {
                        matchScore += 200;
                        matchType = 'number';
                        matchedDetail = queryContainsNum;
                    } else if (partialNumMatch) {
                        matchScore += 50;
                        if (matchType !== 'number') {
                            matchType = 'number';
                            matchedDetail = partialNumMatch;
                        }
                    }
                }

                // 4. Alias/Keyword Matching
                if (mapping.aliases) {
                    mapping.aliases.forEach(alias => {
                        const aliasLower = alias.toLowerCase();
                        if (query.includes(aliasLower)) {
                            matchScore += 40;
                        }
                    });
                }

                // 5. CPU Matching (A-Series, M-Series)
                const modelData = modelsData[modelName] || {};
                const cpu = modelData.cpu ? modelData.cpu.toString().toLowerCase() : '';

                // STRICTER CPU MATCHING
                // 1. Exact Token Match (e.g. "m1" token in query matches "m1" cpu)
                if (cpu && queryTokens.includes(cpu)) {
                    matchScore += 80;
                    if (matchType !== 'name' && matchType !== 'number') {
                        matchType = 'cpu';
                        matchedDetail = modelData.cpu;
                    }
                }
                // 2. Contains (for multi-word CPUs like "A10 Fusion")
                //    BUT ensure we don't match "9" to "A9" loosely.
                else if (cpu && cpu.length > 2 && queryLower.includes(cpu)) {
                    matchScore += 80;
                    if (matchType !== 'name' && matchType !== 'number') {
                        matchType = 'cpu';
                        matchedDetail = modelData.cpu;
                    }
                }

                // 6. Year Matching (e.g. "2020")
                const released = modelData.released ? modelData.released.toString().toLowerCase() : '';
                // "September 2021" -> matches "2021"
                if (released.includes(query)) {
                    matchScore += 60;
                    if (matchType !== 'name' && matchType !== 'number' && matchType !== 'cpu') {
                        matchType = 'year';
                        matchedDetail = modelData.released; // Store date
                    }
                }
            }

            // NEGATIVE PENALTY APPLICATION
            if (isNegativeMatch) {
                // If we found a specific Model Number match (e.g. A1822), we IGNORE the penalty.
                // A user query might be "iPad A1822" (no "5th gen"). A1822 IS iPad 5. 
                // But wait, "iPad A1822" matching "iPad 5" isn't a negative match for "Air/Pro".
                // Negative match is: Query="iPad 5", Model="iPad Air 5". 
                // Does "iPad 5" contain "Air"? No. Model has "Air". -> Negative Match.
                // Does matchType === 'number'? A1822 wouldn't trigger this for Air anyway.
                // So, primarily, just Apply Penalty.
                // UNLESS the query explicitly contains the distinguishing word BUT we missed it?
                // No, we checked hasMini/etc.

                // Only save grace if it's an EXACT Number match which overrides names.
                if (matchType !== 'number') {
                    matchScore -= 1000;
                }
            }

            // FILTER: Require Minimum Score
            if (matchScore > 15) {
                let dedupeKey;
                if (mapping) {
                    dedupeKey = normalizeModelName(mapping.model_name);
                } else {
                    dedupeKey = normalizeModelName(modelName);
                }

                const newResult = {
                    name: canonicalName,
                    originalName: modelName,
                    matchType: matchType,
                    matchedNumber: matchedDetail,
                    score: modelsData[modelName].score,
                    relevance: matchScore,
                    isCanonical: isCanonical,
                    normalizedKey: dedupeKey
                };

                if (uniqueResults.has(dedupeKey)) {
                    const existing = uniqueResults.get(dedupeKey);
                    if (newResult.isCanonical && !existing.isCanonical) {
                        uniqueResults.set(dedupeKey, newResult);
                    }
                    else if (!existing.isCanonical) {
                        const newHasGen = newResult.name.toLowerCase().includes('generation');
                        const oldHasGen = existing.name.toLowerCase().includes('generation');

                        if (newHasGen && !oldHasGen) {
                            uniqueResults.set(dedupeKey, newResult);
                        } else if (newResult.relevance > existing.relevance + 10) {
                            uniqueResults.set(dedupeKey, newResult);
                        }
                    }
                } else {
                    uniqueResults.set(dedupeKey, newResult);
                }
            }
        });

        scoredResults = Array.from(uniqueResults.values());
        scoredResults.sort((a, b) => {
            if (b.relevance !== a.relevance) {
                return b.relevance - a.relevance;
            }
            return a.name.length - b.name.length;
        });

        return scoredResults.slice(0, 10);
    }

    /**
     * Helper: Normalize model name for deduplication
     * E.g. "iPad Air (6th)" -> "ipad air (6th generation)"
     * E.g. "iPad Air 6th Gen" -> "ipad air (6th generation)"
     */
    function normalizeModelName(name) {
        let normalized = name.toLowerCase().trim();

        // Remove "apple" prefix
        normalized = normalized.replace(/^apple\s+/i, '');

        // 1. Normalize Parentheses variants: "(6)", "(6th)", "(6th Gen)" -> " (6th generation)"
        // Matches: space(optional) + "(" + number + suffix(optional) + "gen/generation"(optional) + ")"
        // Be careful not to match "(M2)" as a generation unless we want to, but numbers usually imply gen.
        normalized = normalized.replace(/\s*\(\s*(\d+)(?:st|nd|rd|th)?\s*(?:gen|generation|)?\s*\)/g, (match, num) => {
            return ` (${getOrdinal(num)} generation)`;
        });

        // 2. Normalize "Gen" variants without parens: " 6th Gen", " Gen 6"
        // "Gen 6"
        normalized = normalized.replace(/\s+gen(?:eration)?\s+(\d+)(?:st|nd|rd|th)?/g, (match, num) => {
            return ` (${getOrdinal(num)} generation)`;
        });
        // "6th Gen"
        normalized = normalized.replace(/\s+(\d+)(?:st|nd|rd|th)?\s+gen(?:eration)?/g, (match, num) => {
            return ` (${getOrdinal(num)} generation)`;
        });

        // 3. Normalize "M-Series" chips if in parens or loose: " (M1) "
        // "iPad Air M2" -> "ipad air (m2)"
        // This helps merge "iPad Air (M2)" and "iPad Air M2"
        normalized = normalized.replace(/\s*\(\s*(m\d+)\s*\)/g, ' ($1)'); // Ensure parens are clean
        // If " M2 " exists without parens?
        // normalized = normalized.replace(/\s+(m\d+)(?:\s|$)/g, ' ($1) '); 

        return normalized.trim();
    }

    function getOrdinal(n) {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    function renderResults(matches) {
        searchResults.innerHTML = '';

        // Check if query looks like an MPN (Part Number)
        const query = modelSearchInput.value.trim().toLowerCase();
        // Regex for Part Number: Starts with M,N,F,P + alphanumeric, usually 7-9 chars, often ends with /a (or /something)
        // e.g. mr7f2cl/a -> mr7f2cl/a
        const potentialMPN = /^[mnfp][a-z0-9]{3,}.*/.test(query) && !query.includes('ipad') && matches.length === 0;

        if (matches.length === 0) {
            if (potentialMPN) {
                const li = document.createElement('li');
                li.className = 'no-result-tip';
                li.innerHTML = `
                    <div style="line-height: 1.4; color: #fbbf24;">
                        <strong>Part Number Detected</strong><br>
                        <span style="font-size: 0.85em; color: var(--text-muted)">
                            Settings shows the Part Number (e.g. ${modelSearchInput.value}).<br>
                            <strong>Tap it once</strong> in Settings to reveal the "A" Model Number (e.g. A1893), then search for that!
                        </span>
                    </div>
                 `;
                // Prevent click selection
                searchResults.appendChild(li);
                searchResults.classList.remove('hidden');
                return;
            }

            searchResults.classList.add('hidden');
            return;
        }

        matches.forEach(match => {
            const li = document.createElement('li');

            let displayText = match.name;
            let extraInfo = '';

            if (match.matchType === 'number') {
                // Bold the model number
                displayText = `<strong>${match.matchedNumber}</strong> - ${match.name}`;
            } else if (match.matchType === 'cpu') {
                // Show CPU badge
                extraInfo = `<span class="badge chip-badge matched-badge">${match.matchedNumber}</span>`; // matchedNumber holds the CPU here
            } else if (match.matchType === 'year') {
                // Show Year badge
                extraInfo = `<span class="badge year-badge matched-badge">${match.matchedNumber}</span>`; // matchedNumber holds the release date
            }

            li.innerHTML = `<span>${displayText}</span> ${extraInfo}`;

            li.dataset.original = match.originalName; // Store DB key

            li.addEventListener('click', () => {
                selectModel(match.name, match.originalName);
            });
            searchResults.appendChild(li);
        });
        searchResults.classList.remove('hidden');
    }

    function selectModel(modelName, originalName) {
        modelSearchInput.value = modelName;
        selectedModelIdInput.value = originalName || modelName; // Use DB key if available
        searchResults.classList.add('hidden');
    }

    // --- Calculation Logic ---
    calculateBtn.addEventListener('click', () => {
        // Add animation class
        calculateBtn.classList.add('button-click');
        setTimeout(() => calculateBtn.classList.remove('button-click'), 300);

        const selectedModel = selectedModelIdInput.value;
        const fallbackQuery = modelSearchInput.value;
        const availableModels = Object.keys(modelsData);

        // Logic Check: 
        // If user didn't click a result, try to find the best match automatically
        // Use originalName if available in the selected result context (would need to track it), 
        // but here we just have values.
        // If "selectedModel" is a "Canonical Name", we need to check if it's in modelsData.
        // If not, we might need to find the backing data.
        let finalModel = selectedModel;

        if (!modelsData[finalModel]) {
            // Check if we can reverse-map the canonical name to a DB key?
            // Actually, findMatches now sets 'name' to Canonical.
            // But we need the DB key for modelsData lookup.
            // Simplified: If modelsData[finalModel] is undefined, search for a key that maps to this?
            const foundKey = Object.keys(modelsData).find(k => k === finalModel || (modelMapping.some(m => m.model_name === finalModel && m.model_name.includes(k) && /\d/.test(k))));
            if (foundKey) finalModel = foundKey;
            // Worst case: The deduplication logic picked a "Canonical Name" that isn't a DB key itself.
            // We should persist 'originalName' in the LI dataset to avoid this guessing.
        }

        if (!finalModel && fallbackQuery) {
            // Run search one last time to see if we have a high-confidence top match
            const matches = findMatches(fallbackQuery.toLowerCase().trim());
            if (matches.length > 0 && matches[0].relevance > 0) {
                // If the top match is significantly better or just the only reasonable one
                finalModel = matches[0].name;
                // Auto-select it? Maybe risky, but helps "New iPad Air M3" -> "iPad Air (M2)"
            }
        }

        const price = parseFloat(priceInput.value);

        if (!finalModel) {
            alert("Could not identify specific iPad model. Please select one from the list.");
            return;
        }
        if (!price || price <= 0) {
            alert("Please enter a valid price.");
            return;
        }

        const data = modelsData[finalModel];
        const score = data.score;
        const valueScore = (score / price).toFixed(2);

        addResultRow(finalModel, price, score, valueScore, data.cpu, data.released, data.max_os);

        // Reset inputs
        modelSearchInput.value = '';
        selectedModelIdInput.value = '';
        priceInput.value = '';
        modelSearchInput.focus();
    });

    function addResultRow(modelOrData, priceArg, scoreArg, valueScoreArg, cpuArg, releasedArg, max_osArg, shouldSaveArg) {
        // --- Normalization (Handle Object vs Arguments) ---
        let data = {};
        if (typeof modelOrData === 'object') {
            data = modelOrData;
            // shouldSave is the second arg if first is object
            data.shouldSave = priceArg !== undefined ? priceArg : true;
        } else {
            // Legacy/Positional
            data = {
                model: modelOrData,
                price: priceArg,
                score: scoreArg,
                valueScore: valueScoreArg,
                cpu: cpuArg,
                released: releasedArg,
                max_os: max_osArg,
                shouldSave: shouldSaveArg
            };
        }

        // --- Defaults ---
        const { model, price, score, valueScore, cpu = '-', released = '-', max_os = '-', shouldSave = true, incomplete = false } = data;

        // --- Deduplication Check ---
        // Check if this specific model + price combo already exists
        const existingRows = Array.from(comparisonBody.querySelectorAll('tr'));
        const isDuplicate = existingRows.some(row => {
            const rowModel = row.dataset.model;
            // dataset.price is string, price might be number. Compare loosely or convert.
            const rowPrice = parseFloat(row.dataset.price);
            // Also normalized model names might differ slightly if not careful, but dataset.model should be consistent
            return rowModel === model && rowPrice === parseFloat(price);
        });

        if (isDuplicate) {
            console.log(`Duplicate detected: ${model} @ $${price}. Skipping.`);
            return;
        }

        // Calculate value score if missing (e.g. from bulk)
        let finalValueScore = valueScore;
        if ((!finalValueScore || finalValueScore === 'NaN' || finalValueScore === 'Infinity') && price) {
            if (score && score > 0) {
                finalValueScore = (score / price).toFixed(2);
            } else {
                finalValueScore = '0.00';
            }
        }
        if (incomplete) {
            finalValueScore = 0; // Sort to bottom
        }

        const row = document.createElement('tr');
        row.dataset.value = finalValueScore;
        row.dataset.model = model;
        row.dataset.price = price;
        row.dataset.score = score || 0;
        row.dataset.cpu = cpu;
        row.dataset.released = released;
        row.dataset.max_os = max_os;
        row.dataset.incomplete = incomplete;

        if (incomplete) {
            row.classList.add('incomplete-row');
            row.innerHTML = `
                <td>
                    <div class="model-resolve-wrapper">
                        <input type="text" class="model-resolve-input" value="${model}" placeholder="Type to search definition..." autocomplete="off">
                        <ul class="suggestions-dropdown hidden"></ul>
                    </div>
                </td>
                <td class="price-cell">$${price}</td>
                <td colspan="3"><span class="needs-info-badge">Identify this model to see its value score</span></td>
                <td>?</td>
                <td class="value-cell">
                    <span class="score-val" style="font-size: 0.9em; color: var(--text-muted)">Pending...</span>
                </td>
                <td><button class="delete-btn" aria-label="Remove row">×</button></td>
            `;

            // Add Listener for Resolution
            const resolveInput = row.querySelector('.model-resolve-input');
            const suggestionsList = row.querySelector('.suggestions-dropdown');

            // Function to Finalize Selection
            const finalizeResolution = (selectedModelName) => {
                const fullData = modelsData[selectedModelName];
                if (fullData) {
                    row.remove();
                    addResultRow({
                        model: selectedModelName,
                        price: price,
                        score: fullData.score,
                        cpu: fullData.cpu,
                        released: fullData.released,
                        max_os: fullData.max_os,
                        shouldSave: true
                    });
                    updateLeaderboard();
                }
            };

            // Input Event for Autocomplete
            resolveInput.addEventListener('input', () => {
                const query = resolveInput.value.trim().toLowerCase();
                if (query.length < 1) {
                    suggestionsList.classList.add('hidden');
                    return;
                }

                const matches = findMatches(query);

                if (matches.length > 0) {
                    suggestionsList.innerHTML = '';
                    matches.forEach(match => {
                        const li = document.createElement('li');
                        if (match.matchType === 'number') {
                            li.innerHTML = `<strong>${match.matchedNumber}</strong> - ${match.name}`;
                        } else {
                            li.textContent = match.name;
                        }

                        li.addEventListener('click', (e) => {
                            e.stopPropagation(); // Prevent document click from closing immediately
                            resolveInput.value = match.name;
                            suggestionsList.classList.add('hidden');
                            finalizeResolution(match.name);
                        });
                        suggestionsList.appendChild(li);
                    });
                    suggestionsList.classList.remove('hidden');
                } else {
                    suggestionsList.classList.add('hidden');
                }
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!row.contains(e.target)) {
                    suggestionsList.classList.add('hidden');
                }
            });

            // Handle Enter key
            resolveInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    // Try to resolve exactly or pick first match
                    const query = resolveInput.value.trim();
                    const matches = findMatches(query);
                    if (matches.length > 0) {
                        finalizeResolution(matches[0].name);
                    }
                }
            });

            // Add Focus Listener to show results immediately when clicking
            resolveInput.addEventListener('focus', () => {
                const query = resolveInput.value.trim().toLowerCase();
                if (query.length > 0) {
                    const matches = findMatches(query);
                    if (matches.length > 0) {
                        suggestionsList.innerHTML = '';
                        matches.forEach(match => {
                            const li = document.createElement('li');
                            if (match.matchType === 'number') {
                                li.innerHTML = `<strong>${match.matchedNumber}</strong> - ${match.name}`;
                            } else {
                                li.textContent = match.name;
                            }

                            li.addEventListener('click', (e) => {
                                e.stopPropagation();
                                resolveInput.value = match.name;
                                suggestionsList.classList.add('hidden');
                                finalizeResolution(match.name);
                            });
                            suggestionsList.appendChild(li);
                        });
                        suggestionsList.classList.remove('hidden');
                    }
                }
            });
        } else {
            // Standard Row
            row.innerHTML = `
                <td class="model-name clickable" title="Click to edit model">${model}</td>
                <td class="price-cell clickable" title="Click to edit price">$${price}</td>
                <td><span class="badge chip-badge">${cpu}</span></td>
                <td>${released}</td>
                <td>${max_os}</td>
                <td>${score}</td>
                <td class="value-cell">
                    <span class="score-val">${finalValueScore}</span>
                    <span class="trophy-icon"></span>
                </td>
                <td><button class="delete-btn" aria-label="Remove row">×</button></td>
            `;

            // Make Model Name Editable on Click
            const modelCell = row.querySelector('.model-name');
            modelCell.addEventListener('click', function () {
                // If already editing (has input), do nothing
                if (modelCell.querySelector('input')) return;

                const currentName = modelCell.textContent;
                modelCell.classList.remove('clickable');

                // Inject the Resolver UI (reused logic from incomplete rows)
                modelCell.innerHTML = `
                <div class="model-resolve-wrapper">
                    <input type="text" class="model-resolve-input" placeholder="Type to search..." value="${currentName}">
                    <ul class="suggestions-dropdown hidden"></ul>
                </div>`;

                const resolveInput = modelCell.querySelector('.model-resolve-input');
                const suggestionsList = modelCell.querySelector('.suggestions-dropdown');

                resolveInput.focus();

                // --- Attach Autocomplete Logic (Duplicated from above for speed/safety) ---
                const finalizeResolution = (chosenModelName) => {
                    // Get data for new model
                    const newMatch = findMatches(chosenModelName)[0]; // Assume exact match if chosen
                    if (newMatch) {
                        const newData = modelsData[newMatch.name];
                        // Re-render row with new data (standard addResultRow call won't work easily here, better to update DOM)
                        // Actually, easiest is to remove this row and add a new one with the same price!
                        row.remove();
                        addResultRow({
                            model: newMatch.name,
                            price: price, // Reuse CURRENT price from cell?? No, original price.
                            // Wait, what if price changed? Use current scope price.
                            cpu: newData ? newData.cpu : '?',
                            released: newData ? newData.released : '?',
                            max_os: newData ? newData.max_os : '?',
                            score: newData ? newData.score : 0
                        }, true);
                        applyFilters();
                        saveComparisons();
                    }
                };

                resolveInput.addEventListener('input', () => {
                    const query = resolveInput.value.trim().toLowerCase();
                    suggestionsList.innerHTML = '';
                    if (query.length > 0) {
                        const matches = findMatches(query);
                        matches.forEach(match => {
                            const li = document.createElement('li');
                            li.textContent = match.name;
                            li.addEventListener('click', (e) => {
                                e.stopPropagation();
                                finalizeResolution(match.name);
                            });
                            suggestionsList.appendChild(li);
                        });
                        suggestionsList.classList.remove('hidden');
                    } else {
                        suggestionsList.classList.add('hidden');
                    }
                });

                resolveInput.addEventListener('focus', () => {
                    // Immediately show suggestions
                    const query = resolveInput.value.trim().toLowerCase();
                    if (query.length > 0) resolveInput.dispatchEvent(new Event('input'));
                });

                document.addEventListener('click', (e) => {
                    if (!modelCell.contains(e.target)) {
                        suggestionsList.classList.add('hidden');
                    }
                });
            });

            // Visual Feedback for Max iOS
            // Visual Feedback for Max iOS
            if (max_os === 'Latest') {
                row.classList.add('max-ios-latest');
            } else {
                row.classList.add('max-ios-outdated');
            }
        }

        // Add highlight animation class only if new
        if (shouldSave) {
            row.classList.add('new-row');
        }

        checkEmptyTable(); // Immediately update UI (hide instructions)

        // Event Listener for Delete
        row.querySelector('.delete-btn').addEventListener('click', function () {
            row.remove();
            checkEmptyTable();
            updateLeaderboard();
            saveComparisons();
        });

        // Event Listener for Price Edit
        const priceCell = row.querySelector('.price-cell');
        priceCell.addEventListener('click', function () {
            if (priceCell.querySelector('input')) return; // Already editing

            const currentPrice = row.dataset.price;
            priceCell.innerHTML = `<input type="number" class="price-edit-input" value="${currentPrice}" min="1" step="1">`;
            const input = priceCell.querySelector('input');
            input.focus();

            function saveNewPrice() {
                let newPrice = parseFloat(input.value);
                if (!newPrice || newPrice <= 0) {
                    // Revert if invalid
                    priceCell.innerHTML = `$${currentPrice}`;
                    return;
                }

                // Update data
                row.dataset.price = newPrice;
                const newScore = parseFloat(row.dataset.score);
                const newValueScore = (newScore / newPrice).toFixed(2);
                row.dataset.value = newValueScore;

                // Update UI
                priceCell.innerHTML = `$${newPrice}`;
                row.querySelector('.score-val').textContent = newValueScore;

                // Re-sort and save
                updateLeaderboard();
                saveComparisons();
            }

            input.addEventListener('blur', saveNewPrice);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    input.blur();
                }
            });
        });

        comparisonBody.appendChild(row); // Append first, then sort
        resultContainer.classList.remove('hidden');
        clearAllBtn.classList.remove('hidden');

        applyFilters();

        if (shouldSave) {
            saveComparisons();
        }

        return row;
    }

    // Sorts table based on currentSort and highlights winner among visible
    function updateLeaderboard() {
        const rows = Array.from(comparisonBody.querySelectorAll('tr'));
        if (rows.length === 0) return;

        const { column, direction } = currentSort;

        // Sort rows
        rows.sort((a, b) => {
            let valA, valB;

            if (column === 'model') {
                valA = a.dataset.model.toLowerCase();
                valB = b.dataset.model.toLowerCase();
            } else {
                valA = parseFloat(a.dataset[column]) || 0;
                valB = parseFloat(b.dataset[column]) || 0;
            }

            if (valA < valB) return direction === 'asc' ? -1 : 1;
            if (valA > valB) return direction === 'asc' ? 1 : -1;
            return 0;
        });

        // Re-append in order
        rows.forEach(row => comparisonBody.appendChild(row));

        // Highlight Winner among VISIBLE rows
        rows.forEach(row => {
            row.classList.remove('champion-row');
            const trophy = row.querySelector('.trophy-icon');
            if (trophy) trophy.textContent = '';
        });

        const visibleRows = rows.filter(r => r.style.display !== 'none');
        if (visibleRows.length > 0) {
            // The first visible row is the "winner" based on current sort
            // BUT usually we only want to highlight if sorting by Value Score?
            // User probably wants the best value score to always be highlighted if it's visible.
            // Let's find the absolute best value score among visible rows.
            const winner = visibleRows.reduce((prev, curr) => {
                return (parseFloat(curr.dataset.value) > parseFloat(prev.dataset.value)) ? curr : prev;
            });

            winner.classList.add('champion-row');
            const trophy = winner.querySelector('.trophy-icon');
            if (trophy) trophy.textContent = ' 🏆'; // Trophy Emoji
        }
    }

    // "Clear All" Logic
    if (clearAllBtn) {
        console.log("Clear All Button initialized");
        clearAllBtn.addEventListener('click', () => {
            // confirm() removed for better UX/reliability
            try {
                comparisonBody.innerHTML = '';
                checkEmptyTable();
                localStorage.removeItem('ipadComparisons'); // Explicitly clear storage
            } catch (err) {
                console.error("Error clearing table:", err);
                alert("Error clearing table. See console.");
            }
        });
    }

    // --- Persistence ---
    function saveComparisons() {
        const rows = Array.from(comparisonBody.querySelectorAll('tr'));
        const data = rows.map(row => ({
            model: row.dataset.model,
            price: row.dataset.price,
            score: row.dataset.score,
            valueScore: row.dataset.value,
            cpu: row.dataset.cpu,
            released: row.dataset.released,
            max_os: row.dataset.max_os
        }));
        localStorage.setItem('ipadComparisons', JSON.stringify(data));
    }

    function loadSavedComparisons() {
        const saved = localStorage.getItem('ipadComparisons');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                data.forEach(item => {
                    addResultRow(item.model, item.price, item.score, item.valueScore, item.cpu, item.released, item.max_os, false);
                });
            } catch (e) {
                console.error("Error loading saved data", e);
            }
        }
        checkEmptyTable(); // Update UI state based on loaded data
    }

    // Helper to hide table if empty
    function checkEmptyTable() {
        const instructions = document.getElementById('instructions');
        if (comparisonBody.children.length === 0) {
            resultContainer.classList.add('hidden');
            if (clearAllBtn) clearAllBtn.classList.add('hidden');
            if (instructions) instructions.classList.remove('hidden');
        } else {
            resultContainer.classList.remove('hidden');
            if (clearAllBtn) clearAllBtn.classList.remove('hidden');
            if (instructions) instructions.classList.add('hidden');
        }
    }
});
