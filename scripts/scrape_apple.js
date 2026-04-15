const admin = require("firebase-admin");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require('fs');
const path = require('path');

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('/Users/danielgoneau/Downloads/ipad-compare-firebase-adminsdk-fbsvc-81d928a98a.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const mappingPath = path.join(__dirname, '../public/model_mapping.json');
const specsPath = path.join(__dirname, '../public/model_specs.json');

const APPLE_IDENTIFY_URL = "https://support.apple.com/en-us/108043";

const IPADOS_COMPAT_URLS = [
    { version: "26", url: "https://support.apple.com/guide/ipad/ipad-models-compatible-with-ipados-26-ipad213a25b2/ipados" },
    { version: "18", url: "https://support.apple.com/guide/ipad/ipad-models-compatible-with-ipados-18-ipad213a25b2/18.0/ipados/18.0" },
    { version: "17", url: "https://support.apple.com/guide/ipad/supported-models-ipad213a25b2/17.0/ipados/17.0" },
    { version: "16", url: "https://support.apple.com/guide/ipad/supported-models-ipad213a25b2/16.0/ipados/16.0" },
    { version: "15", url: "https://support.apple.com/guide/ipad/supported-models-ipad213a25b2/15.0/ipados/15.0" },
];

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalize(str) {
    return str.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

async function scrapeModelNumbers() {
    console.log("Scraping Apple model identification page...");
    const { data } = await axios.get(APPLE_IDENTIFY_URL, { headers: { 'User-Agent': USER_AGENT } });
    const $ = cheerio.load(data);

    const modelNumbers = {};

    $('h2, h3, h4, strong, dt').each((_, el) => {
        const heading = $(el).text().trim();
        if (!heading.includes('iPad')) return;

        const name = heading.replace(/\s+/g, ' ').trim();

        const container = $(el).closest('div, section, dd, li');
        const text = container.length ? container.text() : $(el).parent().text();
        const aNumbers = text.match(/A\d{4}/g) || [];

        const uniqueNumbers = [...new Set(aNumbers)];
        if (uniqueNumbers.length > 0) {
            modelNumbers[normalize(name)] = { name, numbers: uniqueNumbers };
        }
    });

    return modelNumbers;
}

async function scrapeMaxOS() {
    console.log("Scraping iPadOS compatibility pages...");

    const versionModels = {};

    for (const { version, url } of IPADOS_COMPAT_URLS) {
        try {
            const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
            const $ = cheerio.load(data);

            const models = [];
            $('li, p').each((_, el) => {
                const text = $(el).text().trim();
                if (text.includes('iPad') && text.length < 200) {
                    models.push(normalize(text));
                }
            });

            versionModels[version] = models;
            console.log(`iPadOS ${version}: found ${models.length} compatible models`);
        } catch (err) {
            console.warn(`Could not scrape iPadOS ${version} page: ${err.message}`);
        }
    }

    return versionModels;
}

function getMaxOS(normalizedName, versionModels) {
    const versions = Object.keys(versionModels).sort((a, b) => parseInt(b) - parseInt(a));

    for (const version of versions) {
        const models = versionModels[version];
        const found = models.some(m => m.includes(normalizedName) || normalizedName.includes(m));
        if (found) {
            if (version === versions[0]) return "Latest";
            return `iPadOS ${version}`;
        }
    }

    return "Unknown";
}

async function main() {
    try {
        const modelMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        const modelSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
        let mappingChanged = false;
        let specsChanged = false;

        const appleModels = await scrapeModelNumbers();
        console.log(`Found model numbers for ${Object.keys(appleModels).length} iPad models on Apple's page`);

        if (Object.keys(appleModels).length < 10) {
            console.error("ERROR: Apple scraper returned fewer than 10 models. Page structure may have changed.");
            if (process.env.GITHUB_ACTIONS) {
                const { execSync } = require('child_process');
                try {
                    execSync('gh issue create --title "Apple scraper failed — page structure may have changed" --body "The Apple support page scraper returned fewer than 10 iPad models, suggesting the page structure has changed. Manual investigation needed." --label "auto-update"', { stdio: 'inherit' });
                } catch (e) {
                    console.warn("Could not create GitHub issue:", e.message);
                }
            }
            process.exit(1);
        }

        for (const entry of modelMapping) {
            const normName = normalize(entry.model_name);

            const match = Object.entries(appleModels).find(([key]) => {
                return key.includes(normName) || normName.includes(key);
            });

            if (match) {
                const [, appleData] = match;
                const newNumbers = appleData.numbers.filter(n => !entry.model_numbers.includes(n));
                if (newNumbers.length > 0) {
                    entry.model_numbers.push(...newNumbers);
                    mappingChanged = true;
                    console.log(`Added model numbers for ${entry.model_name}: ${newNumbers.join(', ')}`);
                }
            }
        }

        const versionModels = await scrapeMaxOS();

        const batch = db.batch();
        let batchCount = 0;

        for (const entry of modelMapping) {
            const normName = normalize(entry.model_name);
            const maxOS = getMaxOS(normName, versionModels);

            if (maxOS !== "Unknown") {
                const docRef = db.collection("geekbench_scores").doc(entry.model_name);
                batch.set(docRef, { max_os: maxOS }, { merge: true });
                batchCount++;

                if (modelSpecs[entry.model_name]) {
                    if (modelSpecs[entry.model_name].max_os !== maxOS) {
                        modelSpecs[entry.model_name].max_os = maxOS;
                        specsChanged = true;
                    }
                }
            }
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Updated max_os for ${batchCount} models in Firestore`);
        }

        if (mappingChanged) {
            fs.writeFileSync(mappingPath, JSON.stringify(modelMapping, null, 4) + '\n');
            console.log("Updated model_mapping.json");
        }
        if (specsChanged) {
            fs.writeFileSync(specsPath, JSON.stringify(modelSpecs, null, 4) + '\n');
            console.log("Updated model_specs.json");
        }

        console.log("Apple scraper complete.");

    } catch (error) {
        console.error("Error in Apple scraper:", error);

        if (process.env.GITHUB_ACTIONS) {
            const { execSync } = require('child_process');
            try {
                execSync(`gh issue create --title "Apple scraper failed" --body "Error: ${error.message.replace(/"/g, '\\"')}" --label "auto-update"`, { stdio: 'inherit' });
            } catch (e) {
                console.warn("Could not create GitHub issue:", e.message);
            }
        }

        process.exit(1);
    }
}

main();
