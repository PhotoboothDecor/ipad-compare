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

const specsPath = path.join(__dirname, '../public/model_specs.json');
const modelSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));

const GEEKBENCH_VERSION = 6;

let mappingChanged = false;
let specsChanged = false;

function generateAliases(modelName) {
    const aliases = [];
    const lower = modelName.toLowerCase();

    let family = '';
    if (lower.includes('air')) family = 'Air';
    else if (lower.includes('pro')) family = 'Pro';
    else if (lower.includes('mini')) family = 'mini';

    const genMatch = modelName.match(/(\d+)(?:st|nd|rd|th)\s*generation/i);
    const genNum = genMatch ? genMatch[1] : null;

    const chipMatch = modelName.match(/\((M\d+|A\d+\s*Pro?)\)/i);
    const chip = chipMatch ? chipMatch[1] : null;

    const sizeMatch = modelName.match(/([\d.]+)-inch/);
    const size = sizeMatch ? sizeMatch[1] : null;

    if (family && genNum) {
        const suffix = getOrdinalSuffix(parseInt(genNum));
        aliases.push(`${family} ${genNum}`);
        aliases.push(`${genNum}${suffix} Gen ${family}`);
        aliases.push(`iPad ${family} ${genNum}`);
    }
    if (family && chip) {
        aliases.push(`${family} ${chip}`);
        if (size) aliases.push(`${family} ${size} ${chip}`);
    }

    return aliases;
}

function getOrdinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return (s[(v - 20) % 10] || s[v] || s[0]);
}

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

            let cpuFromDesc = '';
            if (device.description) {
                const cpuMatch = device.description.match(/Apple\s+([\w\s]+?)(?:\s*@|\s*$)/i);
                if (cpuMatch) cpuFromDesc = cpuMatch[1].trim();
            }

            const matchedModel = modelMapping.find(m => {
                const normModel = normalize(m.model_name);
                if (normModel === normalizedDeviceName) return true;
                if (m.aliases) {
                    return m.aliases.some(alias => normalize(alias) === normalizedDeviceName);
                }
                return false;
            });

            if (matchedModel) {
                console.log(`Mapped '${device.name}' -> '${matchedModel.model_name}'`);
                docName = matchedModel.model_name;
            } else {
                console.log(`No map found for '${device.name}'. Auto-creating mapping entry.`);

                const newEntry = {
                    model_name: device.name,
                    model_numbers: [],
                    aliases: generateAliases(device.name)
                };
                modelMapping.push(newEntry);
                mappingChanged = true;

                if (!modelSpecs[device.name]) {
                    modelSpecs[device.name] = {
                        cpu: cpuFromDesc || 'Unknown',
                        released: new Date().getFullYear().toString(),
                        max_os: 'Latest',
                        score: device.multicore_score || 0,
                        geekbench_version: GEEKBENCH_VERSION
                    };
                    specsChanged = true;
                    console.log(`Auto-added specs for '${device.name}'`);
                }
            }

            const docRef = db.collection("geekbench_scores").doc(docName);

            batch.set(docRef, {
                name: docName,
                original_name: device.name,
                score: device.multicore_score,
                single_core_score: device.score,
                multi_core_score: device.multicore_score,
                description: device.description || "",
                geekbench_version: GEEKBENCH_VERSION,
                last_updated: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            batchCount++;
        }

        if (batchCount > 0) {
            await batch.commit();
            console.log(`Successfully updated ${batchCount} records.`);

        if (mappingChanged) {
            fs.writeFileSync(mappingPath, JSON.stringify(modelMapping, null, 4) + '\n');
            console.log("Updated model_mapping.json with new entries");
        }
        if (specsChanged) {
            fs.writeFileSync(specsPath, JSON.stringify(modelSpecs, null, 4) + '\n');
            console.log("Updated model_specs.json with new entries");
        }

        if (mappingChanged && process.env.GITHUB_ACTIONS) {
            const { execSync } = require('child_process');
            const newModels = modelMapping
                .filter(m => m.model_numbers.length === 0)
                .map(m => m.model_name);
            if (newModels.length > 0) {
                const title = `New model(s) auto-added: ${newModels.join(', ')}`;
                const body = `The daily scrape found new iPad model(s) on Geekbench that were not in model_mapping.json.\n\nModels: ${newModels.join(', ')}\n\nMapping entries were auto-created with empty model_numbers arrays. The Apple scraper will attempt to fill in A-numbers on the next run.\n\nThis issue is for audit trail purposes.`;
                try {
                    execSync(`gh issue create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --label "auto-update"`, { stdio: 'inherit' });
                } catch (e) {
                    console.warn("Could not create GitHub issue:", e.message);
                }
            }
        }
        }

    } catch (error) {
        console.error("Error scraping Geekbench:", error);
        process.exit(1);
    }
}

runScrape();
