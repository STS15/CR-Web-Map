require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT || process.env.POSTGRES_POST || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASS ? String(process.env.POSTGRES_PASS) : undefined,
    database: process.env.POSTGRES_DB || "postgres",
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000
});

pool.on("error", (err) => {
    console.error("Unexpected Postgres error", err);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool
};
