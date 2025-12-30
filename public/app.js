document.addEventListener('DOMContentLoaded', () => {
    const modelSearchInput = document.getElementById('model-search');
    const searchResults = document.getElementById('search-results');
    const selectedModelIdInput = document.getElementById('selected-model-id');
    const priceInput = document.getElementById('price-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const resultContainer = document.getElementById('result-container');
    const comparisonBody = document.getElementById('comparison-body');
    const clearAllBtn = document.getElementById('clear-all-btn');

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
                modelsData[doc.id] = {
                    score: data.score,
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
        // Tokenize Query
        const queryTokens = query.split(/\s+/).filter(t => t.length > 0);
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

        availableModels.forEach(modelName => {
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
            const mapping = modelMapping.find(m => m.model_name === modelName);
            if (mapping && mapping.model_numbers) {
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

                // 4. Alias/Keyword Matching (New)
                if (mapping.aliases) {
                    mapping.aliases.forEach(alias => {
                        const aliasLower = alias.toLowerCase();
                        // Check if alias is in the query (e.g query="ipad air 2022", alias="2022")
                        if (query.includes(aliasLower)) {
                            matchScore += 40; // Significant boost for correct year/chip
                        }
                    });
                }
            }

            if (matchScore > 0) {
                scoredResults.push({
                    name: modelName,
                    matchType: matchType,
                    matchedNumber: matchedDetail,
                    score: modelsData[modelName].score,
                    relevance: matchScore
                });
            }
        });

        // Filter out low relevance if we have high relevance options
        // Sort by relevance descending
        scoredResults.sort((a, b) => b.relevance - a.relevance);

        // Return top 10
        return scoredResults.slice(0, 10);
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
            if (match.matchType === 'number') {
                li.innerHTML = `<strong>${match.matchedNumber}</strong> - ${match.name}`;
            } else {
                li.textContent = match.name;
            }

            li.addEventListener('click', () => {
                selectModel(match.name);
            });
            searchResults.appendChild(li);
        });
        searchResults.classList.remove('hidden');
    }

    function selectModel(modelName) {
        modelSearchInput.value = modelName;
        selectedModelIdInput.value = modelName;
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
        let finalModel = modelsData[selectedModel] ? selectedModel : null;

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

    function addResultRow(model, price, score, valueScore, cpu = '-', released = '-', max_os = '-', shouldSave = true) {
        const row = document.createElement('tr');
        row.dataset.value = valueScore; // Store for sorting
        row.dataset.model = model; // Store for persistence
        row.dataset.price = price;
        row.dataset.score = score;
        row.dataset.cpu = cpu;
        row.dataset.released = released;
        row.dataset.max_os = max_os;

        row.innerHTML = `
            <td class="model-name">${model}</td>
            <td class="price-cell clickable" title="Click to edit price">$${price}</td>
            <td><span class="badge chip-badge">${cpu}</span></td>
            <td>${released}</td>
            <td>${max_os}</td>
            <td>${score}</td>
            <td class="value-cell">
                <span class="score-val">${valueScore}</span>
                <span class="trophy-icon"></span>
            </td>
            <td><button class="delete-btn" aria-label="Remove row">×</button></td>
        `;

        // Add highlight animation class only if new
        if (shouldSave) {
            row.classList.add('new-row');
        }

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
        clearAllBtn.addEventListener('click', () => {
            if (confirm('Clear all comparisons?')) {
                comparisonBody.innerHTML = '';
                checkEmptyTable();
                saveComparisons();
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
    }

    // Helper to hide table if empty
    window.checkEmptyTable = function () {
        if (comparisonBody.children.length === 0) {
            resultContainer.classList.add('hidden');
            clearAllBtn.classList.add('hidden');
        }
    };
});
