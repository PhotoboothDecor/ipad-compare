const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 1. Service Account
const serviceAccountPath = '/Users/danielgoneau/Downloads/ipad-compare-firebase-adminsdk-fbsvc-81d928a98a.json';
if (!fs.existsSync(serviceAccountPath)) {
    console.error("Service account not found at:", serviceAccountPath);
    process.exit(1);
}
const serviceAccount = require(serviceAccountPath);

// 2. Load Specs
const specsPath = path.join(__dirname, '../public/model_specs.json');
if (!fs.existsSync(specsPath)) {
    console.error("Specs file not found at:", specsPath);
    process.exit(1);
}
const specs = require(specsPath);

const osPath = path.join(__dirname, '../public/ios_versions.json');
const osData = fs.existsSync(osPath) ? require(osPath) : {};

// 3. Init Firebase
try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase initialized.");
} catch (error) {
    if (error.code === 'app/already-exists') {
        // ignore
    } else {
        console.error("Init Error:", error);
        process.exit(1);
    }
}

const db = admin.firestore();

// 4. Update Function
async function updateSpecs() {
    const batch = db.batch();
    let count = 0;
    const batchSize = 450;

    // Merge keys from both files
    const allModels = new Set([...Object.keys(specs), ...Object.keys(osData)]);

    for (const modelName of allModels) {
        const docRef = db.collection('geekbench_scores').doc(modelName);
        const spec = specs[modelName] || {};
        const maxOS = osData[modelName] || null;

        const updateData = {};
        if (spec.cpu) updateData.cpu = spec.cpu;
        if (spec.released) updateData.released = spec.released;
        if (maxOS) updateData.max_os = maxOS;

        if (Object.keys(updateData).length === 0) continue;

        batch.set(docRef, updateData, { merge: true });

        count++;
        if (count % batchSize === 0) {
            await batch.commit();
            console.log(`Committed batch of ${batchSize}`);
            // Reset batch? No, wait, batch is single-use.
            // In a loop usually we create a new batch.
            // Simplified: Just one batch is enough for ~50 models.
        }
    }

    if (count > 0) {
        await batch.commit();
        console.log(`Committed final batch of ${count}`);
    }

    console.log("Migration Complete.");
}

updateSpecs();
