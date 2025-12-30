const admin = require("firebase-admin");
const axios = require("axios");
const cheerio = require("cheerio");

// Initialize Firebase with Service Account from Env Var (GitHub) or Local Path
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('/Users/danielgoneau/Downloads/ipad-compare-firebase-adminsdk-fbsvc-81d928a98a.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const WIKI_URL = "https://en.wikipedia.org/wiki/List_of_iPad_models";

async function scrapeWikiAndUpdateDB() {
    try {
        console.log("Starting Wikipedia scrape...");
        const { data } = await axios.get(WIKI_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const $ = cheerio.load(data);

        let updateCount = 0;
        const batch = db.batch();

        // Iterate over likely table rows
        // Using a broad selector to catch multiple tables
        $('table.wikitable tr').each((i, ele) => {
            const row = $(ele);
            const cells = row.find('td');
            const headerCell = row.find('th').first();

            let name = headerCell.text().trim().replace(/\[.*?\]/g, '');
            if (!name || !name.includes('iPad')) {
                name = $(cells[0]).text().trim().replace(/\[.*?\]/g, '');
            }

            if (name && name.includes('iPad')) {
                let maxOS = "Unknown";

                // Search for OS version (iOS/iPadOS/Latest) in cells
                // Searching from the end as it's typically a later column
                for (let k = cells.length - 1; k >= 0; k--) {
                    const text = $(cells[k]).text().trim();
                    if (text.includes("iOS") || text.includes("iPadOS") || text.includes("Latest")) {
                        // Basic validation to ensure it looks like a version
                        if (text.match(/\d+/) || text === 'Latest') {
                            maxOS = text.replace(/\[.*?\]/g, '').trim();
                            break;
                        }
                    }
                }

                if (maxOS !== "Unknown") {
                    const docRef = db.collection("geekbench_scores").doc(name);
                    batch.set(docRef, {
                        max_os: maxOS,
                        last_wiki_scrape: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });

                    updateCount++;
                }
            }
        });

        console.log(`Prepared updates for ${updateCount} models.`);
        if (updateCount > 0) {
            await batch.commit();
            console.log("Database updated successfully.");
        } else {
            console.log("No updates found. Verify selector.");
        }

    } catch (error) {
        console.error("Error scraping Wikipedia:", error);
        process.exit(1);
    }
}

scrapeWikiAndUpdateDB();
