const fs = require("fs/promises");
const path = require("path");
const { randomUUID: cryptoRandomUUID } = require("crypto");
let uuidv4 = null;
try { uuidv4 = require("uuid").v4; } catch (_) { /* optional */ }

const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "features.json");

/**
 * Ensures the data file exists and returns an empty structure if missing.
 * @returns {Promise<void>} Promise that resolves when the store is initialized.
 */
async function ensureStore() {
    try {
        await fs.access(DATA_PATH);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_PATH, JSON.stringify({ features: [] }, null, 2));
    }
}

/**
 * Generates a stable unique identifier.
 * @returns {string} RFC4122 UUID string.
 */
function makeId() {
    if (typeof cryptoRandomUUID === "function") return cryptoRandomUUID();
    if (typeof uuidv4 === "function") return uuidv4();
    const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    return `${rnd().slice(0,8)}-${rnd().slice(0,4)}-4${rnd().slice(0,3)}-a${rnd().slice(0,3)}-${rnd()}${rnd().slice(0,4)}`;
}

/**
 * Reads all features from the store.
 * @returns {Promise<Array<Object>>} List of GeoJSON Feature objects.
 */
async function readAllFeatures() {
    await ensureStore();
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    return data.features || [];
}

/**
 * Inserts or updates a feature and persists it.
 * @param {Object} feature GeoJSON Feature with optional id in properties._id.
 * @returns {Promise<Object>} The saved feature including its identifier.
 */
async function upsertFeature(feature) {
    const current = await readAllFeatures();
    const id = feature?.properties?._id || makeId();
    const withId = {
        ...feature,
        properties: { ...(feature.properties || {}), _id: id }
    };
    const idx = current.findIndex(f => f.properties?._id === id);
    if (idx >= 0) current[idx] = withId;
    else current.push(withId);
    await fs.writeFile(DATA_PATH, JSON.stringify({ features: current }, null, 2));
    return withId;
}

/**
 * Deletes a feature by identifier.
 * @param {string} id Identifier stored in properties._id.
 * @returns {Promise<void>} Promise that resolves when deletion completes.
 */
async function deleteFeatureById(id) {
    const current = await readAllFeatures();
    const filtered = current.filter(f => f.properties?._id !== id);
    await fs.writeFile(DATA_PATH, JSON.stringify({ features: filtered }, null, 2));
}

module.exports = {
    ensureStore,
    readAllFeatures,
    upsertFeature,
    deleteFeatureById
};
