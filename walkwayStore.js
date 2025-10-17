const fs = require("fs/promises");
const path = require("path");
const { randomUUID: cryptoRandomUUID } = require("crypto");

/**
 * Generates a UUID with crypto.randomUUID fallback shim.
 * @returns {string} UUID string.
 */
function makeId() {
    if (typeof cryptoRandomUUID === "function") return cryptoRandomUUID();
    return "w-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "walkways.json");

/**
 * Ensures the walkway data file exists.
 * @returns {Promise<void>} Resolves when the store is initialized.
 */
async function ensureWalkwayStore() {
    try {
        await fs.access(DATA_PATH);
    } catch {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(DATA_PATH, JSON.stringify({ features: [] }, null, 2));
    }
}

/**
 * Reads all walkway features.
 * @returns {Promise<Array<Object>>} GeoJSON Feature list.
 */
async function readAllWalkways() {
    await ensureWalkwayStore();
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    return data.features || [];
}

/**
 * Inserts or updates a walkway feature.
 * @param {Object} feature GeoJSON Feature (LineString).
 * @returns {Promise<Object>} Saved feature with properties._id.
 */
async function upsertWalkway(feature) {
    const current = await readAllWalkways();
    const id = feature?.properties?._id || makeId();
    const withId = { ...feature, properties: { ...(feature.properties || {}), _id: id } };
    const idx = current.findIndex(f => f.properties?._id === id);
    if (idx >= 0) current[idx] = withId; else current.push(withId);
    await fs.writeFile(DATA_PATH, JSON.stringify({ features: current }, null, 2));
    return withId;
}

/**
 * Deletes a walkway feature by ID.
 * @param {string} id Feature identifier.
 * @returns {Promise<void>} Resolves when deletion completes.
 */
async function deleteWalkwayById(id) {
    const current = await readAllWalkways();
    const filtered = current.filter(f => f.properties?._id !== id);
    await fs.writeFile(DATA_PATH, JSON.stringify({ features: filtered }, null, 2));
}

module.exports = {
    ensureWalkwayStore,
    readAllWalkways,
    upsertWalkway,
    deleteWalkwayById
};
