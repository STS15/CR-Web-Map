const { upsertFeature } = require("../store");

/**
 * Seeds a sample building polygon to get started.
 * @returns {Promise<void>} Promise that resolves after seeding completes.
 */
async function main() {
    await upsertFeature({
        type: "Feature",
        properties: { type: "building", name: "Sample Hall" },
        geometry: {
            type: "Polygon",
            coordinates: [[
                [-124.0818, 40.8663],
                [-124.0815, 40.8663],
                [-124.0815, 40.8661],
                [-124.0818, 40.8661],
                [-124.0818, 40.8663]
            ]]
        }
    });
    console.log("Seeded sample building.");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
