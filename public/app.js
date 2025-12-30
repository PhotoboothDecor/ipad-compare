document.addEventListener('DOMContentLoaded', () => {
    const modelSelect = document.getElementById('model-select');
    const priceInput = document.getElementById('price-input');
    const calculateBtn = document.getElementById('calculate-btn');
    const resultArea = document.getElementById('result-area');
    const scoreValue = document.getElementById('score-value');
    const gbScoreDisplay = document.getElementById('gb-score');

    let db;
    let scores = {};

    try {
        const app = firebase.app();
        db = firebase.firestore();
        console.log("Firebase initialized");
        loadModels();
    } catch (e) {
        console.error("Firebase init error", e);
        modelSelect.innerHTML = '<option>Error loading models</option>';
    }

    async function loadModels() {
        try {
            const snapshot = await db.collection('geekbench_scores').get();
            if (snapshot.empty) {
                modelSelect.innerHTML = '<option value="">No models found</option>';
                return;
            }

            modelSelect.innerHTML = '<option value="">Select an iPad model</option>';
            snapshot.forEach(doc => {
                const data = doc.data();
                // Store score for lookup
                scores[doc.id] = data.score;

                const option = document.createElement('option');
                option.value = doc.id;
                option.textContent = doc.id; // Using doc ID as model name for now
                modelSelect.appendChild(option);
            });
            modelSelect.disabled = false;
        } catch (error) {
            console.error("Error loading models:", error);
            modelSelect.innerHTML = '<option>Error loading models</option>';
        }
    }

    calculateBtn.addEventListener('click', () => {
        const selectedModel = modelSelect.value;
        const price = parseFloat(priceInput.value);

        if (!selectedModel || !price || price <= 0) {
            alert("Please select a model and enter a valid price.");
            return;
        }

        const score = scores[selectedModel];
        if (!score) {
            alert("Score data missing for this model.");
            return;
        }

        // Logic: Score / Price
        // Example: 1000 score / $500 = 2.0 (Points per dollar)
        const valueScore = (score / price).toFixed(2);

        scoreValue.textContent = valueScore;
        gbScoreDisplay.textContent = score;
        resultArea.classList.remove('hidden');
    });
});
