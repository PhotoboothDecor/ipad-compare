document.addEventListener('DOMContentLoaded', () => {
    const modelSearchInput = document.getElementById('model-search');
    const searchResults = document.getElementById('suggestions');
    const priceInput = document.getElementById('price-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const resultContainer = document.getElementById('result-container');
    const comparisonBody = document.getElementById('comparison-body');
    const clearAllBtn = document.getElementById('clear-all-btn');

    // Tab Elements
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const bulkInput = document.getElementById('bulk-input');
    const processBulkBtn = document.getElementById('process-bulk-btn');

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
                return;
            }
            snapshot.forEach(doc => {
                const data = doc.data();
                modelsData[data.name || doc.id] = {
                    score: data.multi_core_score || 0,
                    cpu: data.cpu || 'Unknown',
                    released: data.released || 'Unknown',
                    max_os: data.max_os || 'Unknown'
                };
            });
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

    // --- Bulk Process Logic (Improved) ---
    processBulkBtn.addEventListener('click', async () => {
        const rawText = bulkInput.value;
        if (!rawText.trim()) return;

        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let processedCount = 0;
        let pendingTitle = null; // Store a title if we find a line with no price

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // 1. Skip obvious junk lines 
            // Common locations: "Ottawa, ON", "Gatineau, QC"
            // Marketing/Status: "Ships to you", "Door pickup", "Seller rating", "Condition"
            const junkPatterns = [
                /^[A-Za-z\s\.]+, [A-Z]{2}$/, // City, ST location
                /^Ships to you/i,
                /^Door pickup/i,
                /^Porch pickup/i,
                /^Local pickup/i,
                /^Seller rating/i,
                /^Condition:/i,
                /^Sold/i,
                /^Pending$/i,
                /^\d+\s+ratings/i, // e.g. "5 ratings"
                /^In stock/i,
                /^Out of stock/i,
                /^Listed/i
            ];

            const isJunk = junkPatterns.some(pattern => line.match(pattern));
            if (isJunk) {
                continue;
            }

            // 2. Identify Price
            // Regex: Looks for $ followed by digits, OR CA$ followed by digits.
            // Also supports just digits at end of line if reasonable price (e.g. > 20)
            const priceRegex = /(?:CA\s*|US\s*)?\$([\d,]+)/i;
            const priceMatch = line.match(priceRegex);

            let price = null;
            let namePart = "";

            if (priceMatch) {
                // Found an explicit price (e.g. CA$470, $400)
                const rawPrice = priceMatch[1].replace(/,/g, '');
                price = parseInt(rawPrice);

                // Check text BEFORE the price on this line
                // e.g. "iPad Air $300" -> name="iPad Air"
                // e.g. "CA$470" -> name="" (empty)
                const textBeforePrice = line.substring(0, priceMatch.index).trim();

                // If text before price is substantial, use it as name.
                // If it's just "CA" or empty, rely on pendingTitle.
                if (textBeforePrice.length > 2 && textBeforePrice.toUpperCase() !== 'CA') {
                    namePart = textBeforePrice;
                    pendingTitle = null; // Consumed
                } else if (pendingTitle) {
                    // Use the previous line as the title
                    namePart = pendingTitle;
                    pendingTitle = null; // Consumed
                } else {
                    // No name found on this line or previous. Skip or mark unknown.
                    // It might be a price update line "CA$450" after "CA$400".
                    // For now, ignore orphan prices to avoid noise.
                    continue;
                }

            } else {
                // No explicit price symbol found. 
                // Check for loose number at END of line? (risky, e.g. "iPad 4")
                // Only if typical price range > 20? 
                const looseNumberMatch = line.match(/(\d+)$/);
                if (looseNumberMatch && parseInt(looseNumberMatch[1]) > 20) {
                    // Treated as price line?
                    // e.g. "iPad Air 400"
                    price = parseInt(looseNumberMatch[1]);
                    namePart = line.substring(0, looseNumberMatch.index).trim();

                    if (!namePart && pendingTitle) {
                        namePart = pendingTitle;
                        pendingTitle = null; // Consumed
                    }
                } else {
                    // Likely a Title line or Description.
                    // Store it as pendingTitle for the *next* line to pick up.
                    // e.g. "Blue iPad in Ottawa, ON"
                    pendingTitle = line;
                    continue; // Move to next line to look for price
                }
            }

            // Clean up Name Part
            // 1. Remove "in City, ST" location suffix
            namePart = namePart.replace(/\s+in\s+[A-Za-z\s\.]+, [A-Z]{2}$/i, '');
            // 2. Remove common prefixes that confuse matcher if not exact
            // e.g. "Apple iPad..." -> "iPad..." (Matcher works better with standard starts)
            namePart = namePart.replace(/^Apple\s+/i, '');
            // 3. Remove "Blue", "Silver", "Space Gray", "Gold" colors if at start
            namePart = namePart.replace(/^(Blue|Pink|Silver|Gold|Space Gray|Space Grey)\s+/i, '');
            // 4. Remove condition/marketing prefixes (New, Like New, Brand New)
            namePart = namePart.replace(/^(New|Brand New|Like New|Used|Mint)\s+/i, '');

            namePart = namePart.trim();

            if (!price) continue;

            if (!namePart) {
                namePart = "Unknown Model";
                // This allows the row to be created with the price, 
                // and the user can use the "Resolve" dropdown to fix the name.
            }

            // --- Process Row ---
            const matches = findMatches(namePart, modelMapping);

            if (matches && matches.length > 0) {
                const bestMatch = matches[0];
                const modelData = modelsData[bestMatch.model_name];

                if (modelData) {
                    addResultRow({
                        model: bestMatch.model_name,
                        score: modelData.score,
                        price: price,
                        cpu: modelData.cpu,
                        released: modelData.released,
                        max_os: modelData.max_os
                    }, true);
                    processedCount++;
                }
            } else {
                addResultRow({
                    model: namePart,
                    price: price,
                    incomplete: true
                }, true);
                processedCount++;
            }
        }

        if (processedCount > 0) {
            bulkInput.value = ''; // Clear input on success
            // updateLeaderboard called inside addResultRow usually, but good to be safe
            updateLeaderboard();
            checkEmptyTable();
            document.getElementById('result-container').scrollIntoView({ behavior: 'smooth' });
        } else {
            alert('Could not find any valid listings. Try copying closer to the "Title... Price" area.');
        }
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
        const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 0);
        if (queryTokens.length === 0) return [];

        let scoredResults = [];
        const availableModels = Object.keys(modelsData);

        // Check for MPN Pattern (Marketing Part Number) e.g. MR7F2CL/A
        // Starts with M, N, F, P; 
        // Note: Our query is lowercased.
        // Regex: Starts with m, n, f, p; followed by alphanumerics; 
        // simple heuristic: starts with valid char, has length > 5, not "ipad"
        const mpnPattern = /^[mnfp][a-z0-9]{3,}/i;
        const isPotentialMPN = mpnPattern.test(query) && !query.includes('ipad');

        if (isPotentialMPN && scoredResults.length === 0) {
            // We handle this in render to show specific message if no other matches
        }

        // Deduplication Map: Key = Canonical Name, Value = Result Object
        const uniqueResults = new Map();

        availableModels.forEach(modelName => {
            // FILTER: Skip OS versions (e.g., "iPadOS 15.x", "iOS 12.x")
            if (/^(iPadOS|iOS)\s/i.test(modelName)) return;

            const modelLower = modelName.toLowerCase();
            let matchScore = 0;
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
                if (modelLower.includes(token)) {
                    tokenMatches++;
                }
            });
            matchScore += (tokenMatches * 10);

            // 3. A-Number Matching (Check Mapping)
            let canonicalName = modelName; // Default to self
            let isCanonical = false;

            const mapping = modelMapping.find(m => {
                // Check if this modelName IS the canonical name
                if (m.model_name === modelName) return true;

                // Robust Check: Normalize both strings to handle "iPad (8th)" vs "iPad (8th generation)"
                // Remove parentheses and lowercase
                const mappingNorm = m.model_name.replace(/[()]/g, '').toLowerCase();
                const modelNorm = modelName.replace(/[()]/g, '').toLowerCase();

                // Check inclusion AND ensure a digit is present (so we don't map "iPad" to everything)
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

                    if (exactNumMatch) {
                        matchScore += 200; // Exact A-Number is very strong
                        matchType = 'number';
                        matchedDetail = exactNumMatch;
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
                // We only care if the query matches the CPU name specifically
                // e.g. "a12", "m1"
                if (cpu.includes(query) || queryTokens.some(t => cpu.includes(t))) {
                    matchScore += 80; // High relevance for CPU
                    if (matchType !== 'name' && matchType !== 'number') {
                        matchType = 'cpu';
                        matchedDetail = modelData.cpu; // Store actual CPU name
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

            if (matchScore > 0) {
                // DEDUPLICATION STRATEGY
                // We want to group "iPad Air (6th)" and "iPad Air (6th generation)" together.
                // 1. If mapping exists, use the mapping's normalized name as the key (strongest link).
                // 2. If no mapping, use our generating normalizer to create a standard key.

                let dedupeKey;
                if (mapping) {
                    dedupeKey = normalizeModelName(mapping.model_name);
                } else {
                    dedupeKey = normalizeModelName(modelName);
                }

                const newResult = {
                    name: canonicalName, // Use canonical name for display if available
                    originalName: modelName,
                    matchType: matchType,
                    matchedNumber: matchedDetail,
                    score: modelsData[modelName].score,
                    relevance: matchScore,
                    isCanonical: isCanonical,
                    normalizedKey: dedupeKey // Store key for debug/logic
                };

                // Logic: 
                // If we have "iPad Air (6th)" (mapped to nothing) -> Key: "ipad air (6th generation)"
                // If we have "iPad Air (6th generation)" (mapped to nothing) -> Key: "ipad air (6th generation)"
                // They share a key -> Deduplication happens!

                if (uniqueResults.has(dedupeKey)) {
                    const existing = uniqueResults.get(dedupeKey);

                    // Merging Logic:
                    // 1. Prefer the one that is Explicitly Canonical (from mapping source)
                    if (newResult.isCanonical && !existing.isCanonical) {
                        uniqueResults.set(dedupeKey, newResult);
                    }
                    // 2. If neither is canonical, prefer the one with a "better" name (e.g. contains "generation" vs just number)
                    else if (!existing.isCanonical) {
                        const newHasGen = newResult.name.toLowerCase().includes('generation');
                        const oldHasGen = existing.name.toLowerCase().includes('generation');

                        if (newHasGen && !oldHasGen) {
                            uniqueResults.set(dedupeKey, newResult);
                        } else if (newResult.relevance > existing.relevance + 10) {
                            // Only overwrite if significantly more relevant (unlikely for dupes)
                            uniqueResults.set(dedupeKey, newResult);
                        }
                    }
                } else {
                    uniqueResults.set(dedupeKey, newResult);
                }
            }
        });

        // Convert Map to Array
        scoredResults = Array.from(uniqueResults.values());

        // Filter out low relevance if we have high relevance options
        // Sort by relevance descending
        scoredResults.sort((a, b) => b.relevance - a.relevance);

        // Return top 10
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

        // Calculate value score if missing (e.g. from bulk)
        let finalValueScore = valueScore;
        if (!finalValueScore && score && price) {
            finalValueScore = (score / price).toFixed(2);
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
                <td colspan="3"><span class="needs-info-badge">Identify Model</span></td>
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
        } else {
            // Standard Row
            row.innerHTML = `
                <td class="model-name">${model}</td>
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

        updateLeaderboard();

        if (shouldSave) {
            saveComparisons();
        }
    }

    // Sorts table by Value Score (Low to High) and highlights winner
    function updateLeaderboard() {
        const rows = Array.from(comparisonBody.querySelectorAll('tr'));

        if (rows.length === 0) return;

        // Sort rows: Higher valueScore is better (Points per Dollar)
        rows.sort((a, b) => {
            return parseFloat(b.dataset.value) - parseFloat(a.dataset.value);
        });

        // Re-append in order
        rows.forEach(row => comparisonBody.appendChild(row));

        // Highlight Winner
        rows.forEach(row => {
            row.classList.remove('champion-row');
            const trophy = row.querySelector('.trophy-icon');
            if (trophy) trophy.textContent = '';
        });

        if (rows.length > 0) {
            const winner = rows[0];
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
