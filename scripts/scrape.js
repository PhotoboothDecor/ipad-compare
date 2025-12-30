const admin = require("firebase-admin");
const axios = require("axios");

// Initialize Firebase with Service Account from Env Var
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const GEEKBENCH_URL = "https://browser.geekbench.com/ios-benchmarks.json";

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
            const docRef = db.collection("geekbench_scores").doc(device.name);

            batch.set(docRef, {
                name: device.name,
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
