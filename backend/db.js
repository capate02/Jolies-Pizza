
require("dotenv").config();

const mysql = require("mysql2/promise");

if (process.env.NODE_ENV === "production") {
    const missingDatabaseSettings = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]
        .filter(key => !String(process.env[key] || "").trim());
    if (missingDatabaseSettings.length) {
        throw new Error(`Missing required production database settings: ${missingDatabaseSettings.join(", ")}`);
    }
}

const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "223173",
    database: process.env.DB_NAME || "jolies_pizza",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true
});

module.exports = pool;
