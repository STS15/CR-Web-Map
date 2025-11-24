const { randomUUID: cryptoRandomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { query } = require("./db");
let uuidv4 = null;
try { uuidv4 = require("uuid").v4; } catch (_) { /* optional */ }

const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "features.json");
let tablesReady = false;
const SHOULD_SEED_FROM_JSON = process.env.SEED_FROM_JSON === "true";

function makeId() {
    if (typeof cryptoRandomUUID === "function") return cryptoRandomUUID();
    if (typeof uuidv4 === "function") return uuidv4();
    const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    return `${rnd().slice(0, 8)}-${rnd().slice(0, 4)}-4${rnd().slice(0, 3)}-a${rnd().slice(0, 3)}-${rnd()}${rnd().slice(0, 4)}`;
}

function toJsonb(val) {
    return val == null ? null : JSON.stringify(val);
}

function getBBox(geom) {
    if (!geom || !geom.coordinates) return null;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const visit = coords => {
        if (!coords) return;
        if (typeof coords[0] === "number" && typeof coords[1] === "number") {
            const [lon, lat] = coords;
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                minLon = Math.min(minLon, lon);
                minLat = Math.min(minLat, lat);
                maxLon = Math.max(maxLon, lon);
                maxLat = Math.max(maxLat, lat);
            }
            return;
        }
        for (const c of coords) visit(c);
    };
    visit(geom.coordinates);
    if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return null;
    return { minLon, minLat, maxLon, maxLat };
}

async function ensureTables() {
    if (tablesReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS features (
            id TEXT PRIMARY KEY,
            type TEXT,
            name TEXT,
            number TEXT,
            building_id TEXT,
            prefix TEXT,
            direction TEXT,
            point_lon DOUBLE PRECISION,
            point_lat DOUBLE PRECISION,
            bbox_min_lon DOUBLE PRECISION,
            bbox_min_lat DOUBLE PRECISION,
            bbox_max_lon DOUBLE PRECISION,
            bbox_max_lat DOUBLE PRECISION,
            data JSONB,
            geom JSONB
        );
    `);
    const addCol = async (col, def) => query(`ALTER TABLE features ADD COLUMN IF NOT EXISTS ${col} ${def};`);
    await addCol("type", "TEXT");
    await addCol("name", "TEXT");
    await addCol("number", "TEXT");
    await addCol("building_id", "TEXT");
    await addCol("prefix", "TEXT");
    await addCol("direction", "TEXT");
    await addCol("point_lon", "DOUBLE PRECISION");
    await addCol("point_lat", "DOUBLE PRECISION");
    await addCol("bbox_min_lon", "DOUBLE PRECISION");
    await addCol("bbox_min_lat", "DOUBLE PRECISION");
    await addCol("bbox_max_lon", "DOUBLE PRECISION");
    await addCol("bbox_max_lat", "DOUBLE PRECISION");
    await addCol("geom", "JSONB");
    tablesReady = true;
    if (SHOULD_SEED_FROM_JSON) {
        await maybeImportFromJson();
    }
}

async function maybeImportFromJson() {
    try {
        const countRes = await query("SELECT COUNT(*)::int AS n FROM features");
        if ((countRes.rows[0].n || 0) > 0) return;
    } catch (e) {
        console.warn("Count check failed, skipping import", e);
        return;
    }

    try {
        const raw = await fs.readFile(DATA_PATH, "utf8");
        const data = JSON.parse(raw);
        const feats = data.features || [];
        let imported = 0;
        for (const f of feats) {
            const geom = f.geometry || null;
            if (!geom) continue; // skip invalid
            const id = f?.properties?._id || makeId();
            const withId = { ...f, properties: { ...(f.properties || {}), _id: id }, geometry: geom };
            const p = withId.properties || {};
            const bbox = getBBox(geom);
            const isPoint = geom && geom.type === "Point" && Array.isArray(geom.coordinates);
            const pointLon = isPoint ? geom.coordinates[0] : null;
            const pointLat = isPoint ? geom.coordinates[1] : null;
            await query(
                `INSERT INTO features (id, type, name, number, building_id, prefix, direction,
                                       point_lon, point_lat,
                                       bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat,
                                       data, geom)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    id,
                    p.type || null,
                    p.name || null,
                    p.number || null,
                    p.buildingId || null,
                    p.prefix || null,
                    p.direction || null,
                    pointLon,
                    pointLat,
                    bbox ? bbox.minLon : null,
                    bbox ? bbox.minLat : null,
                    bbox ? bbox.maxLon : null,
                    bbox ? bbox.maxLat : null,
                    toJsonb(withId),
                    toJsonb(geom || {})
                ]
            );
            imported += 1;
        }
        console.log(`Imported ${imported} features from JSON`);
    } catch (e) {
        console.warn("Feature JSON import skipped", e.message);
    }
}

async function readAllFeatures() {
    await ensureTables();
    const res = await query("SELECT id, type, name, number, building_id, prefix, direction, data, geom FROM features");
    return res.rows.map(r => {
        if (r.data) return r.data;
        return {
            type: "Feature",
            geometry: r.geom || null,
            properties: {
                _id: r.id,
                type: r.type,
                name: r.name,
                number: r.number,
                buildingId: r.building_id,
                prefix: r.prefix,
                direction: r.direction
            }
        };
    });
}

async function upsertFeature(feature) {
    await ensureTables();
    const id = feature?.properties?._id || makeId();
    const withId = { ...feature, properties: { ...(feature.properties || {}), _id: id } };
    const p = withId.properties || {};
    const geom = withId.geometry || null;
    const bbox = getBBox(geom);
    const isPoint = geom && geom.type === "Point" && Array.isArray(geom.coordinates);
    const pointLon = isPoint ? geom.coordinates[0] : null;
    const pointLat = isPoint ? geom.coordinates[1] : null;
    await query(
        `INSERT INTO features (id, type, name, number, building_id, prefix, direction,
                               point_lon, point_lat,
                               bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat,
                               data, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            name = EXCLUDED.name,
            number = EXCLUDED.number,
            building_id = EXCLUDED.building_id,
            prefix = EXCLUDED.prefix,
            direction = EXCLUDED.direction,
            point_lon = EXCLUDED.point_lon,
            point_lat = EXCLUDED.point_lat,
            bbox_min_lon = EXCLUDED.bbox_min_lon,
            bbox_min_lat = EXCLUDED.bbox_min_lat,
            bbox_max_lon = EXCLUDED.bbox_max_lon,
            bbox_max_lat = EXCLUDED.bbox_max_lat,
            data = EXCLUDED.data,
            geom = EXCLUDED.geom`,
        [
            id,
            p.type || null,
            p.name || null,
            p.number || null,
            p.buildingId || null,
            p.prefix || null,
            p.direction || null,
            pointLon,
            pointLat,
            bbox ? bbox.minLon : null,
            bbox ? bbox.minLat : null,
            bbox ? bbox.maxLon : null,
            bbox ? bbox.maxLat : null,
            toJsonb(withId),
            toJsonb(geom || {})
        ]
    );
    return withId;
}

async function deleteFeatureById(id) {
    await ensureTables();
    await query("DELETE FROM features WHERE id = $1", [id]);
}

module.exports = {
    readAllFeatures,
    upsertFeature,
    deleteFeatureById
};
