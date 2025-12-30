const admin = require("firebase-admin");
const axios = require("axios");

const fs = require('fs');
const path = require('path');

// Initialize Firebase with Service Account from Env Var
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('/Users/danielgoneau/Downloads/ipad-compare-firebase-adminsdk-fbsvc-81d928a98a.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const GEEKBENCH_URL = "https://browser.geekbench.com/ios-benchmarks.json";

// Load Model Mapping
const mappingPath = path.join(__dirname, '../public/model_mapping.json');
const modelMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

function normalize(str) {
    return str.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

async function runScrape() {
    try {
        console.log("Starting Geekbench scrape...");
        const response = await axios.get(GEEKBENCH_URL);
        const data = response.data;
        const devices = data.devices;

        if (!devices) {
            throw new Error("No devices found in Geekbench response");
        }

        const ipadDevices = devices.filter(device =>
            device.name && device.name.includes("iPad")
        );

        console.log(`Found ${ipadDevices.length} iPad models.`);

        const batch = db.batch();
        let batchCount = 0;

        for (const device of ipadDevices) {
            let docName = device.name;
            const normalizedDeviceName = normalize(device.name);

            // value matching
            const matchedModel = modelMapping.find(m => {
                const normModel = normalize(m.model_name);
                if (normModel === normalizedDeviceName) return true;
                // Check aliases if exists
                if (m.aliases) {
                    return m.aliases.some(alias => normalize(alias) === normalizedDeviceName);
                }
                return false;
            });

            if (matchedModel) {
                console.log(`Mapped '${device.name}' -> '${matchedModel.model_name}'`);
                docName = matchedModel.model_name;
            } else {
                console.log(`No map found for '${device.name}', using original.`);
            }

            const docRef = db.collection("geekbench_scores").doc(docName);

            batch.set(docRef, {
                name: docName, // Use canonical name
                original_name: device.name,
                score: device.multicore_score,
                single_core_score: device.score,
                multi_core_score: device.multicore_score,
                description: device.description || "",
                last_updated: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            batchCount++;
            // Note: Firestore limit is 500 per batch. iPad models are <100, so one batch is fine.
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Successfully updated ${batchCount} records.`);
        }

    } catch (error) {
        console.error("Error scraping Geekbench:", error);
        process.exit(1);
    }
}

runScrape();
