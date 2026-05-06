const { query } = require("./db");

async function createBugReportsTable() {
    await query(`
        CREATE TABLE IF NOT EXISTS bug_reports (
            id SERIAL PRIMARY KEY,
            description TEXT NOT NULL,
            zoom NUMERIC,
            lat NUMERIC,
            lng NUMERIC,
            reported_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

async function insertBugReport({ description, zoom, lat, lng }) {
    const result = await query(
        `INSERT INTO bug_reports (description, zoom, lat, lng)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [description, zoom, lat, lng]
    );
    return result.rows[0];
}

async function getAllBugReports() {
    const result = await query(
        `SELECT * FROM bug_reports ORDER BY reported_at DESC`
    );
    return result.rows;
}

async function deleteBugReport(id) {
    await query(`DELETE FROM bug_reports WHERE id = $1`, [id]);
}

module.exports = { createBugReportsTable, insertBugReport, getAllBugReports, deleteBugReport };