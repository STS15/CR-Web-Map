const { randomUUID: cryptoRandomUUID } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { query } = require("./db");

const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "walkways.json");
let tablesReady = false;
const SHOULD_SEED_FROM_JSON = process.env.SEED_FROM_JSON === "true";

function sanitizeJson(obj) {
    try {
        const str = JSON.stringify(obj, function (_k, v) {
            if (typeof v === "number" && !Number.isFinite(v)) return null;
            if (v === undefined) return null;
            return v;
        });
        return JSON.parse(str);
    } catch (_e) {
        return null;
    }
}

function toJsonb(val) {
    return val == null ? null : JSON.stringify(val);
}

function makeId() {
    if (typeof cryptoRandomUUID === "function") return cryptoRandomUUID();
    return "w-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function ensureTables() {
    if (tablesReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS walkways (
            id TEXT PRIMARY KEY,
            type TEXT,
            name TEXT,
            curved BOOLEAN,
            segmented BOOLEAN,
            segment_index INTEGER,
            start_lon DOUBLE PRECISION,
            start_lat DOUBLE PRECISION,
            end_lon DOUBLE PRECISION,
            end_lat DOUBLE PRECISION,
            control_start_lon DOUBLE PRECISION,
            control_start_lat DOUBLE PRECISION,
            control_end_lon DOUBLE PRECISION,
            control_end_lat DOUBLE PRECISION,
            control JSONB,
            data JSONB,
            geom JSONB
        );
    `);
    const addCol = async (col, def) => query(`ALTER TABLE walkways ADD COLUMN IF NOT EXISTS ${col} ${def};`);
    await addCol("type", "TEXT");
    await addCol("name", "TEXT");
    await addCol("curved", "BOOLEAN");
    await addCol("segmented", "BOOLEAN");
    await addCol("segment_index", "INTEGER");
    await addCol("start_lon", "DOUBLE PRECISION");
    await addCol("start_lat", "DOUBLE PRECISION");
    await addCol("end_lon", "DOUBLE PRECISION");
    await addCol("end_lat", "DOUBLE PRECISION");
    await addCol("control_start_lon", "DOUBLE PRECISION");
    await addCol("control_start_lat", "DOUBLE PRECISION");
    await addCol("control_end_lon", "DOUBLE PRECISION");
    await addCol("control_end_lat", "DOUBLE PRECISION");
    await addCol("control", "JSONB");
    await addCol("data", "JSONB");
    await addCol("geom", "JSONB");
    tablesReady = true;
    if (SHOULD_SEED_FROM_JSON) {
        await maybeImportFromJson();
    }
}

async function maybeImportFromJson() {
    try {
        const countRes = await query("SELECT COUNT(*)::int AS n FROM walkways");
        if ((countRes.rows[0].n || 0) > 0) return;
    } catch (e) {
        console.warn("Walkway count check failed, skipping import", e);
        return;
    }

    try {
        const raw = await fs.readFile(DATA_PATH, "utf8");
        const data = JSON.parse(raw);
        const feats = data.features || [];
        let imported = 0;
        for (const f of feats) {
            try {
                if (!f.geometry) continue; // skip invalid
                const id = f?.properties?._id || makeId();
                const withId = sanitizeJson({ ...f, properties: { ...(f.properties || {}), _id: id }, geometry: f.geometry });
                if (!withId) continue;
                const p = withId.properties || {};
                const segmentIndexVal = Number.isFinite(Number(p.segmentIndex)) ? Number(p.segmentIndex) : null;
                const coords = Array.isArray(withId.geometry.coordinates) ? withId.geometry.coordinates : [];
                const start = coords[0] || [];
                const end = coords[coords.length - 1] || [];
                const controlArr = Array.isArray(p.control) ? p.control : null;
                const controlStart = controlArr && controlArr[0] ? controlArr[0] : null;
                const controlEnd = controlArr && controlArr[controlArr.length - 1] ? controlArr[controlArr.length - 1] : null;
                await query(
                    `INSERT INTO walkways (id, type, name, curved, segmented, segment_index,
                                           start_lon, start_lat, end_lon, end_lat,
                                           control_start_lon, control_start_lat, control_end_lon, control_end_lat,
                                           control, data, geom)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
                     ON CONFLICT (id) DO NOTHING`,
                    [
                        id,
                        p.type || "walkway",
                        p.name || null,
                        p.curved === true,
                        p.segmented === true,
                        segmentIndexVal,
                        start[0] ?? null,
                        start[1] ?? null,
                        end[0] ?? null,
                        end[1] ?? null,
                        controlStart ? controlStart[0] : null,
                        controlStart ? controlStart[1] : null,
                        controlEnd ? controlEnd[0] : null,
                        controlEnd ? controlEnd[1] : null,
                        toJsonb(controlArr || null),
                        toJsonb(withId),
                        toJsonb(withId.geometry || {})
                    ]
                );
                imported += 1;
            } catch (err) {
                console.error("Walkway import failed for feature:", JSON.stringify(f, null, 2), "error:", err.message);
            }
        }
        console.log(`Imported ${imported} walkways from JSON`);
    } catch (e) {
        console.warn("Walkway JSON import skipped", e.message);
    }
}

async function readAllWalkways() {
    await ensureTables();
        const res = await query("SELECT id, type, name, curved, segmented, segment_index, start_lon, start_lat, end_lon, end_lat, control_start_lon, control_start_lat, control_end_lon, control_end_lat, control, data, geom FROM walkways");
        return res.rows.map(r => {
            if (r.data) return r.data;
            return {
                type: "Feature",
                geometry: r.geom || {
                    type: "LineString",
                    coordinates: [
                        [r.start_lon, r.start_lat],
                        [r.end_lon, r.end_lat]
                    ]
                },
                properties: {
                    _id: r.id,
                    type: r.type || "walkway",
                    name: r.name,
                    curved: !!r.curved,
                    segmented: !!r.segmented,
                    segmentIndex: r.segment_index,
                    control: r.control || (r.control_start_lon != null ? [
                        [r.control_start_lon, r.control_start_lat],
                        [r.control_end_lon, r.control_end_lat]
                    ] : undefined)
                }
            };
        });
}

async function upsertWalkway(feature) {
    await ensureTables();
    const id = feature?.properties?._id || makeId();
    const withId = sanitizeJson({ ...feature, properties: { ...(feature.properties || {}), _id: id } });
    if (!withId || !withId.geometry) return feature; // invalid, skip
    const p = withId.properties || {};
    const geom = withId.geometry || null;
    const segmentIndexVal = Number.isFinite(Number(p.segmentIndex)) ? Number(p.segmentIndex) : null;
    const coords = Array.isArray(withId.geometry.coordinates) ? withId.geometry.coordinates : [];
    const start = coords[0] || [];
    const end = coords[coords.length - 1] || [];
    const controlArr = Array.isArray(p.control) ? p.control : null;
    const controlStart = controlArr && controlArr[0] ? controlArr[0] : null;
    const controlEnd = controlArr && controlArr[controlArr.length - 1] ? controlArr[controlArr.length - 1] : null;
    await query(
        `INSERT INTO walkways (id, type, name, curved, segmented, segment_index,
                               start_lon, start_lat, end_lon, end_lat,
                               control_start_lon, control_start_lat, control_end_lon, control_end_lat,
                               control, data, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
         ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            name = EXCLUDED.name,
            curved = EXCLUDED.curved,
            segmented = EXCLUDED.segmented,
            segment_index = EXCLUDED.segment_index,
            control = EXCLUDED.control,
            data = EXCLUDED.data,
            geom = EXCLUDED.geom`,
        [
            id,
            p.type || "walkway",
            p.name || null,
            p.curved === true,
            p.segmented === true,
            segmentIndexVal,
            start[0] ?? null,
            start[1] ?? null,
            end[0] ?? null,
            end[1] ?? null,
            controlStart ? controlStart[0] : null,
            controlStart ? controlStart[1] : null,
            controlEnd ? controlEnd[0] : null,
            controlEnd ? controlEnd[1] : null,
            toJsonb(controlArr || null),
            toJsonb(withId),
            toJsonb(geom || {})
        ]
    );
    return withId;
}

async function deleteWalkwayById(id) {
    await ensureTables();
    await query("DELETE FROM walkways WHERE id = $1", [id]);
}

module.exports = {
    readAllWalkways,
    upsertWalkway,
    deleteWalkwayById
};
