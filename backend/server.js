/* =========================================================
   JOLIE'S PIZZA
   NODE.JS SERVER + MYSQL + REGISTER + LOGIN
   Pure Node.js HTTP server (no Express.js)
========================================================= */

require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const db = require("./db");

const PORT = Number(process.env.PORT || 3000);
const API_SESSION_TTL = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
let googlePublicKeys = null;
let googlePublicKeysExpireAt = 0;
const pendingGoogleNonces = new Map();
let warnedAboutOptionalGpsSchema = false;
const DELIVERY_AREA_BOUNDS = Object.freeze({
    south: 12.43,
    north: 12.68,
    west: 124.77,
    east: 125.02
});

// Update this list if your frontend runs on a different origin.
const ALLOWED_ORIGINS = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
]);

/* =========================================================
   JSON RESPONSE
========================================================= */

function sendJSON(res, statusCode, data) {
    if (res.writableEnded) return;

    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

/* =========================================================
   READ JSON REQUEST BODY
========================================================= */

function readJSON(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;

        req.on("data", chunk => {
            size += chunk.length;

            if (size > 1024 * 1024) {
                reject(new Error("Request body is too large."));
                req.destroy();
                return;
            }
            body += chunk;
        });

        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON request body."));
            }
        });

        req.on("error", reject);
    });
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;

        req.on("data", chunk => {
            size += chunk.length;
            if (size > 1024 * 1024) {
                tooLarge = true;
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            if (tooLarge) {
                reject(new Error("Webhook request body is too large."));
                return;
            }
            resolve(Buffer.concat(chunks));
        });
        req.on("error", reject);
    });
}

function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        let finished = false;

        req.on("data", chunk => {
            body += chunk.toString();

            if (body.length > 1024 * 1024 && !finished) {
                finished = true;
                reject(new Error("Request body is too large."));
                req.destroy();
            }
        });

        req.on("end", () => {
            if (finished) return;

            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON request."));
            }
        });

        req.on("error", error => {
            if (!finished) {
                finished = true;
                reject(error);
            }
        });
    });
}

function cleanText(value, maxLength = 255) {
    return typeof value === "string"
        ? value.trim().slice(0, maxLength)
        : "";
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getGooglePublicKeys() {
    if (googlePublicKeys && Date.now() < googlePublicKeysExpireAt) {
        return googlePublicKeys;
    }

    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!response.ok) throw new Error("Could not load Google's signing keys.");

    const data = await response.json();
    const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1] || 3600);
    googlePublicKeys = data.keys || [];
    googlePublicKeysExpireAt = Date.now() + Math.max(60, maxAge) * 1000;
    return googlePublicKeys;
}

async function verifyGoogleIdToken(idToken, expectedNonce) {
    const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
    if (!clientId) throw new Error("Google sign-in is not configured. Add GOOGLE_CLIENT_ID to backend/.env.");

    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) throw new Error("Google returned an invalid sign-in token.");

    let header;
    let claims;
    try {
        header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        throw new Error("Google returned an invalid sign-in token.");
    }

    if (header.alg !== "RS256" || !header.kid) {
        throw new Error("Google returned an unsupported sign-in token.");
    }

    const keys = await getGooglePublicKeys();
    const jwk = keys.find(key => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) {
        googlePublicKeysExpireAt = 0;
        const refreshedKeys = await getGooglePublicKeys();
        const refreshedJwk = refreshedKeys.find(key => key.kid === header.kid && key.kty === "RSA");
        if (!refreshedJwk) throw new Error("Google signing key was not recognized.");
        return verifyGoogleClaimsAndSignature(parts, header, claims, refreshedJwk, clientId, expectedNonce);
    }
    return verifyGoogleClaimsAndSignature(parts, header, claims, jwk, clientId, expectedNonce);
}

function verifyGoogleClaimsAndSignature(parts, header, claims, jwk, clientId, expectedNonce) {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const signatureValid = crypto.verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2], "base64url")
    );
    const issuerValid = ["accounts.google.com", "https://accounts.google.com"].includes(claims.iss);

    if (!signatureValid || claims.aud !== clientId || !issuerValid || Number(claims.exp) <= Math.floor(Date.now() / 1000)) {
        throw new Error("Google sign-in could not be verified. Please try again.");
    }
    if (!expectedNonce || claims.nonce !== expectedNonce) {
        throw new Error("Google sign-in expired or could not be verified. Please try again.");
    }
    if (!claims.sub || !validEmail(String(claims.email || "")) || claims.email_verified !== true) {
        throw new Error("Use a Google account with a verified email address.");
    }
    const verifiedEmail = String(claims.email).trim().toLowerCase();
    const googleControlsEmail = verifiedEmail.endsWith("@gmail.com") || Boolean(cleanText(claims.hd, 255));
    if (!googleControlsEmail) {
        throw new Error("Use a Gmail or Google Workspace account for secure sign-in.");
    }
    return {
        email: verifiedEmail,
        fullName: cleanText(claims.name, 150) || String(claims.email).split("@")[0]
    };
}

function issueGoogleNonce() {
    const now = Date.now();
    for (const [nonce, expiresAt] of pendingGoogleNonces) {
        if (expiresAt <= now) pendingGoogleNonces.delete(nonce);
    }
    if (pendingGoogleNonces.size >= 1000) {
        const oldestNonce = pendingGoogleNonces.keys().next().value;
        if (oldestNonce) pendingGoogleNonces.delete(oldestNonce);
    }
    const nonce = crypto.randomBytes(32).toString("hex");
    pendingGoogleNonces.set(nonce, now + 5 * 60 * 1000);
    return nonce;
}

function isWithinDeliveryArea(latitude, longitude) {
    return latitude >= DELIVERY_AREA_BOUNDS.south &&
        latitude <= DELIVERY_AREA_BOUNDS.north &&
        longitude >= DELIVERY_AREA_BOUNDS.west &&
        longitude <= DELIVERY_AREA_BOUNDS.east;
}

function setCors(req, res) {
    const origin = req.headers.origin;

    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    );
}

async function createApiSession(email, role, remember = false) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + (
        remember ? REMEMBERED_SESSION_TTL : API_SESSION_TTL
    ));
    await db.execute("DELETE FROM api_sessions WHERE expires_at <= NOW()");
    await db.execute(
        `INSERT INTO api_sessions (token_hash, email, role, expires_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE email = VALUES(email), role = VALUES(role), expires_at = VALUES(expires_at)`,
        [tokenHash, email, role, expiresAt]
    );
    return token;
}

async function getApiSession(req) {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(
        req.headers.authorization || ""
    );

    if (!match) return null;

    const token = match[1].toLowerCase();
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const [rows] = await db.execute(
        `SELECT email, role, expires_at
         FROM api_sessions
         WHERE token_hash = ? AND expires_at > NOW()
         LIMIT 1`,
        [tokenHash]
    );
    const session = rows[0];

    if (!session) return null;

    return { token, email: session.email, role: session.role };
}

async function deleteApiSession(session) {
    if (!session?.token) return;
    const tokenHash = crypto.createHash("sha256").update(session.token).digest("hex");
    await db.execute("DELETE FROM api_sessions WHERE token_hash = ?", [tokenHash]);
}

async function ensureStaffManagementSchema() {
    const [columns] = await db.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    const existing = new Set(columns.map(column => column.COLUMN_NAME));
    const additions = [
        ["approval_status", "ENUM('pending','approved','declined') NOT NULL DEFAULT 'approved'"],
        ["staff_position", "VARCHAR(80) NULL"],
        ["staff_shift", "VARCHAR(100) NULL"],
        ["staff_address", "VARCHAR(500) NULL"],
        ["created_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"]
    ];
    for (const [name, definition] of additions) {
        if (!existing.has(name)) await db.execute(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
    await db.execute(`
        CREATE TABLE IF NOT EXISTS staff_attendance (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT UNSIGNED NOT NULL,
            session_token_hash CHAR(64) NOT NULL,
            time_in DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            time_out DATETIME NULL,
            INDEX idx_staff_attendance_user_date (user_id, time_in),
            UNIQUE KEY uq_staff_attendance_session (session_token_hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

async function recordStaffTimeIn(userId, sessionToken) {
    const sessionHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
    await db.execute(
        "INSERT INTO staff_attendance (user_id, session_token_hash) VALUES (?, ?)",
        [userId, sessionHash]
    );
}

async function recordStaffTimeOut(session) {
    if (!session?.token || session.role !== "staff") return;
    const sessionHash = crypto.createHash("sha256").update(session.token).digest("hex");
    await db.execute(
        "UPDATE staff_attendance SET time_out = NOW() WHERE session_token_hash = ? AND time_out IS NULL",
        [sessionHash]
    );
}

/* =========================================================
   REGISTER USER
========================================================= */

async function registerUser(req, res) {
    try {
        const body = await getRequestBody(req);

        const fullName = String(body.fullName || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        const phone = String(body.phone || "").trim();
        const password = String(body.password || "");
        const confirmPassword = String(body.confirmPassword || "");
        const role = String(body.role || "").trim().toLowerCase();
        const termsAccepted = body.termsAccepted === true;

        if (!fullName || !email || !phone || !password || !confirmPassword || !role) {
            return sendJSON(res, 400, {
                success: false,
                message: "Please complete all required fields."
            });
        }

        const allowedRoles = ["customer", "staff"];

        if (!allowedRoles.includes(role)) {
            return sendJSON(res, 400, {
                success: false,
                message: "Invalid account type."
            });
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(email)) {
            return sendJSON(res, 400, {
                success: false,
                message: "Please enter a valid email address."
            });
        }

        if (password.length < 8) {
            return sendJSON(res, 400, {
                success: false,
                message: "Password must be at least 8 characters."
            });
        }

        if (password !== confirmPassword) {
            return sendJSON(res, 400, {
                success: false,
                message: "Passwords do not match."
            });
        }

        if (!termsAccepted) {
            return sendJSON(res, 400, {
                success: false,
                message: "You must agree to the Terms and Conditions and Privacy Policy."
            });
        }

        const [existingUsers] = await db.execute(
            `SELECT id
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        if (existingUsers.length > 0) {
            return sendJSON(res, 409, {
                success: false,
                message: "An account with this email already exists."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const [result] = await db.execute(
            `INSERT INTO users
                (full_name, email, phone, password_hash, role, is_active, approval_status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [fullName, email, phone, passwordHash, role, role === "staff" ? 0 : 1, role === "staff" ? "pending" : "approved"]
        );

        return sendJSON(res, 201, {
            success: true,
            message: role === "staff"
                ? "Your staff account request was sent to the administrator for approval. You can log in after it is approved."
                : "Your account has been created successfully.",
            user: {
                id: result.insertId,
                fullName,
                email,
                phone,
                role,
                approvalStatus: role === "staff" ? "pending" : "approved"
            }
        });
    } catch (error) {
        console.error("REGISTER ERROR:", error);

        if (error.message === "Invalid JSON request.") {
            return sendJSON(res, 400, {
                success: false,
                message: error.message
            });
        }

        if (error.code === "ER_DUP_ENTRY") {
            return sendJSON(res, 409, {
                success: false,
                message: "An account with this email already exists."
            });
        }

        return sendJSON(res, 500, {
            success: false,
            message: "Server error during registration. Please try again."
        });
    }
}

/* =========================================================
   LOGIN USER
========================================================= */

async function loginUser(req, res) {
    try {
        const body = await getRequestBody(req);

        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const requestedRole = String(body.role || "").trim().toLowerCase();
        const remember = body.remember === true;

        if (!email || !password || !requestedRole) {
            return sendJSON(res, 400, {
                success: false,
                message: "Enter your email, password, and account type."
            });
        }

        const allowedRoles = ["customer", "staff", "admin"];

        if (!allowedRoles.includes(requestedRole)) {
            return sendJSON(res, 400, {
                success: false,
                message: "Invalid account type."
            });
        }

        const [rows] = await db.execute(
            `SELECT id, full_name, email, password_hash, role, is_active, approval_status
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email]
        );

        if (rows.length === 0) {
            return sendJSON(res, 401, {
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = rows[0];
        const passwordMatches = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return sendJSON(res, 401, {
                success: false,
                message: "Invalid email or password."
            });
        }

        if (String(user.role).toLowerCase() !== requestedRole) {
            return sendJSON(res, 403, {
                success: false,
                message: "The selected account type does not match your registered account."
            });
        }

        if (String(user.role).toLowerCase() === "staff" && user.approval_status !== "approved") {
            return sendJSON(res, 403, {
                success: false,
                message: user.approval_status === "declined"
                    ? "Your staff account request was declined. Please contact the administrator."
                    : "Your staff account is waiting for administrator approval."
            });
        }

        if (Number(user.is_active) !== 1) {
            return sendJSON(res, 403, {
                success: false,
                message: "Your account is inactive. Please contact the administrator."
            });
        }

        const sessionToken = await createApiSession(
            user.email,
            String(user.role).toLowerCase(),
            remember
        );

        if (String(user.role).toLowerCase() === "staff") {
            await recordStaffTimeIn(user.id, sessionToken);
        }

        return sendJSON(res, 200, {
            success: true,
            message: "Login successful.",
            sessionToken,
            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error("LOGIN ERROR:", error);

        if (error.message === "Invalid JSON request.") {
            return sendJSON(res, 400, {
                success: false,
                message: error.message
            });
        }

        return sendJSON(res, 500, {
            success: false,
            message: "A server error occurred during login."
        });
    }
}

/* =========================================================
   MENU + ORDER API
========================================================= */

async function getCategories() {
    const [rows] = await db.execute(
        `SELECT id, name, slug
         FROM categories
         WHERE COALESCE(is_active, TRUE) = TRUE
         ORDER BY name ASC`
    );

    return rows;
}

async function getProducts(url) {
    const category = cleanText(url.searchParams.get("category"), 100);
    const search = cleanText(url.searchParams.get("search"), 100);

    let sql = `
        SELECT
            p.id,
            p.name,
            p.description,
            p.price,
            p.image_url,
            p.tags,
            p.category_id,
            p.is_available,
            c.name AS category_name,
            c.slug AS category
        FROM products p
        INNER JOIN categories c ON c.id = p.category_id
        WHERE c.is_active = TRUE
    `;

    const params = [];

    if (category && category !== "all") {
        sql += " AND c.slug = ?";
        params.push(category);
    }

    if (search) {
        sql += " AND (p.name LIKE ? OR p.description LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
    }

    sql += " ORDER BY p.name ASC";

    const [rows] = await db.execute(sql, params);
    return rows;
}

async function getCustomerOrders(email) {
    const [orders] = await db.execute(
        `SELECT
            id,
            order_number,
            customer_name,
            customer_email,
            customer_phone,
            delivery_address,
            fulfillment_type,
            pickup_time,
            pickup_status,
            subtotal,
            delivery_fee,
            total,
            status,
            payment_method,
            payment_status,
            created_at
         FROM customer_orders
         WHERE customer_email = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [email]
    );

    if (orders.length === 0) {
        return [];
    }

    const orderIds = orders.map(order => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const [items] = await db.execute(
        `SELECT
            oi.order_id,
            oi.product_id,
            oi.product_name,
            oi.product_price,
            oi.quantity,
            oi.line_total,
            oi.selected_size,
            p.image_url
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id IN (${placeholders})
         ORDER BY oi.id ASC`,
        orderIds
    );

    const itemsByOrderId = new Map();

    for (const item of items) {
        const orderItems = itemsByOrderId.get(item.order_id) || [];
        orderItems.push({
            productId: item.product_id,
            name: item.product_name,
            price: Number(item.product_price),
            quantity: item.quantity,
            lineTotal: Number(item.line_total),
            size: item.selected_size,
            image: item.image_url
        });
        itemsByOrderId.set(item.order_id, orderItems);
    }

    return orders.map(order => ({
        id: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        customerPhone: order.customer_phone,
        deliveryAddress: order.delivery_address,
        fulfillmentType: order.fulfillment_type,
        pickupTime: order.pickup_time,
        pickupStatus: order.pickup_status || "scheduled",
        subtotal: Number(order.subtotal),
        deliveryFee: Number(order.delivery_fee),
        total: Number(order.total),
        status: order.status,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        createdAt: order.created_at,
        items: itemsByOrderId.get(order.id) || []
    }));
}

async function getStaffOrders() {
    const [orders] = await db.execute(
        `SELECT
            co.id,
            co.order_number,
            co.customer_name,
            co.customer_phone,
            co.delivery_address,
            co.fulfillment_type,
            co.pickup_time,
            co.pickup_status,
            da.rider_name,
            da.rider_phone,
            co.subtotal,
            co.delivery_fee,
            co.total,
            co.status,
            co.payment_method,
            co.payment_status,
            co.created_at
         FROM customer_orders co
         LEFT JOIN delivery_assignments da ON da.order_id = co.id
         ORDER BY co.created_at DESC, co.id DESC
         LIMIT 200`
    );

    if (orders.length === 0) return [];

    const orderIds = orders.map(order => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const [items] = await db.execute(
        `SELECT order_id, product_name, product_price, quantity
         FROM order_items
         WHERE order_id IN (${placeholders})
         ORDER BY id ASC`,
        orderIds
    );
    const itemsByOrderId = new Map();
    for (const item of items) {
        const list = itemsByOrderId.get(item.order_id) || [];
        list.push({
            name: item.product_name,
            price: Number(item.product_price),
            quantity: Number(item.quantity)
        });
        itemsByOrderId.set(item.order_id, list);
    }

    return orders.map(order => ({
        orderNumber: order.order_number,
        customerName: order.customer_name,
        customerPhone: order.customer_phone,
        deliveryAddress: order.delivery_address,
        fulfillmentType: order.fulfillment_type,
        pickupTime: order.pickup_time,
        pickupStatus: order.pickup_status || "scheduled",
        riderAssigned: Boolean(order.rider_name),
        subtotal: Number(order.subtotal),
        deliveryFee: Number(order.delivery_fee),
        total: Number(order.total),
        status: order.status,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        createdAt: order.created_at,
        items: itemsByOrderId.get(order.id) || []
    }));
}

function reportWindow(period) {
    if (period === "today") return { days: 1, label: "Today" };
    if (period === "month") return { days: 30, label: "Last 30 days" };
    return { days: 7, label: "Last 7 days" };
}

async function getStaffDashboardData() {
    const [[summary]] = await db.execute(
        `SELECT
            SUM(status = 'Pending') AS newOrders,
            SUM(status = 'Preparing') AS preparing,
            SUM(status = 'Out for Delivery' OR pickup_status = 'ready') AS readyOrders,
            SUM(status = 'Completed' AND DATE(created_at) = CURDATE()) AS completedToday,
            COALESCE(SUM(CASE WHEN payment_status = 'Paid' AND status != 'Cancelled' AND DATE(created_at) = CURDATE() THEN total ELSE 0 END), 0) AS salesToday,
            COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS ordersToday
         FROM customer_orders`
    );
    const [orders] = await db.execute(
        `SELECT co.id, co.order_number, co.customer_name, co.fulfillment_type,
                co.status, co.payment_status, co.total, co.created_at,
                GROUP_CONCAT(CONCAT(oi.quantity, '× ', oi.product_name) ORDER BY oi.id SEPARATOR ', ') AS itemSummary,
                SUM(oi.quantity) AS itemCount
         FROM customer_orders co
         LEFT JOIN order_items oi ON oi.order_id = co.id
         WHERE co.status IN ('Pending', 'Preparing', 'Out for Delivery')
            OR co.pickup_status = 'ready'
         GROUP BY co.id
         ORDER BY FIELD(co.status, 'Pending', 'Preparing', 'Out for Delivery'), co.created_at ASC
         LIMIT 8`
    );
    const [salesByHour] = await db.execute(
        `SELECT HOUR(created_at) AS hour, COALESCE(SUM(total), 0) AS sales
         FROM customer_orders
         WHERE DATE(created_at) = CURDATE() AND payment_status = 'Paid' AND status != 'Cancelled'
         GROUP BY HOUR(created_at) ORDER BY hour`
    );
    let inventoryAlerts = [];
    try {
        const [columns] = await db.execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items'`
        );
        const names = new Set(columns.map(column => column.COLUMN_NAME));
        const nameColumn = names.has("name") ? "name" : names.has("item_name") ? "item_name" : null;
        const stockColumn = names.has("current_stock") ? "current_stock" : names.has("stock_quantity") ? "stock_quantity" : null;
        const thresholdColumn = names.has("low_stock_threshold") ? "low_stock_threshold" : names.has("reorder_level") ? "reorder_level" : null;
        if (nameColumn && stockColumn) {
            const thresholdSql = thresholdColumn ? `\`${thresholdColumn}\`` : "0";
            const activeFilter = names.has("is_active") ? "WHERE is_active = TRUE" : "";
            const [rows] = await db.execute(
                `SELECT \`${nameColumn}\` AS name, \`${stockColumn}\` AS stock, ${thresholdSql} AS threshold
                 FROM inventory_items ${activeFilter}
                 ORDER BY (\`${stockColumn}\` <= ${thresholdSql}) DESC, \`${stockColumn}\` ASC LIMIT 6`
            );
            inventoryAlerts = rows.filter(row => Number(row.stock) <= Number(row.threshold)).map(row => ({
                name: row.name, stock: Number(row.stock), threshold: Number(row.threshold)
            }));
        }
    } catch (error) {
        console.warn("Could not load optional dashboard inventory alerts:", error.code || error.message);
    }
    return {
        summary: {
            newOrders: Number(summary.newOrders || 0), preparing: Number(summary.preparing || 0),
            readyOrders: Number(summary.readyOrders || 0), completedToday: Number(summary.completedToday || 0),
            salesToday: Number(summary.salesToday || 0), ordersToday: Number(summary.ordersToday || 0)
        },
        orders: orders.map(order => ({
            id: order.id, orderNumber: order.order_number, customerName: order.customer_name || "Walk-in Customer",
            fulfillmentType: order.fulfillment_type || "Dine-in", status: order.status,
            paymentStatus: order.payment_status, total: Number(order.total), createdAt: order.created_at,
            itemSummary: order.itemSummary || "No items", itemCount: Number(order.itemCount || 0)
        })),
        salesByHour: salesByHour.map(row => ({ hour: Number(row.hour), sales: Number(row.sales) })),
        inventoryAlerts
    };
}

async function getStaffReportData(period) {
    const window = reportWindow(period);
    const days = window.days;
    const currentFilter = `created_at >= DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY) AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;
    const previousFilter = `created_at >= DATE_SUB(CURDATE(), INTERVAL ${days * 2 - 1} DAY) AND created_at < DATE_SUB(CURDATE(), INTERVAL ${days - 1} DAY)`;
    const aggregate = async filter => {
        const [[row]] = await db.execute(
            `SELECT COUNT(*) AS orders,
                COALESCE(SUM(CASE WHEN status = 'Completed' AND payment_status = 'Paid' THEN total ELSE 0 END), 0) AS sales,
                SUM(status = 'Completed') AS completed,
                SUM(status = 'Cancelled') AS cancelled,
                SUM(status = 'Pending') AS pending,
                SUM(status = 'Confirmed') AS confirmed,
                SUM(status = 'Preparing') AS preparing,
                SUM(status = 'Out for Delivery') AS outForDelivery,
                SUM(status NOT IN ('Completed', 'Cancelled', 'Pending', 'Confirmed', 'Preparing', 'Out for Delivery')) AS other
             FROM customer_orders WHERE ${filter}`
        );
        return {
            orders: Number(row.orders || 0), sales: Number(row.sales || 0), completed: Number(row.completed || 0),
            cancelled: Number(row.cancelled || 0), pending: Number(row.pending || 0), confirmed: Number(row.confirmed || 0),
            preparing: Number(row.preparing || 0), outForDelivery: Number(row.outForDelivery || 0), other: Number(row.other || 0)
        };
    };
    const [current, previous, daily, hourly, topItems, paymentMethods, fulfillmentSales] = await Promise.all([
        aggregate(currentFilter), aggregate(previousFilter),
        db.execute(`SELECT DATE(created_at) AS day, COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status = 'Completed' AND payment_status = 'Paid' THEN total ELSE 0 END), 0) AS sales,
            SUM(status = 'Completed') AS completed
            FROM customer_orders WHERE ${currentFilter} GROUP BY DATE(created_at) ORDER BY day`),
        db.execute(`SELECT HOUR(created_at) AS hour, COUNT(*) AS orders FROM customer_orders
            WHERE ${currentFilter} GROUP BY HOUR(created_at) ORDER BY hour`),
        db.execute(`SELECT oi.product_name AS name, SUM(oi.quantity) AS quantity,
            SUM(oi.line_total) AS revenue FROM order_items oi
            INNER JOIN customer_orders co ON co.id = oi.order_id
            WHERE co.${currentFilter} AND co.status != 'Cancelled'
            GROUP BY oi.product_name ORDER BY quantity DESC, revenue DESC LIMIT 8`),
        db.execute(`SELECT payment_method AS method, COUNT(*) AS orders, SUM(total) AS amount
            FROM customer_orders WHERE ${currentFilter} AND payment_status = 'Paid' AND status != 'Cancelled'
            GROUP BY payment_method ORDER BY amount DESC`),
        db.execute(`SELECT fulfillment_type AS type, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS amount
            FROM customer_orders WHERE ${currentFilter} AND payment_status = 'Paid' AND status != 'Cancelled'
            GROUP BY fulfillment_type ORDER BY amount DESC`)
    ]);
    const [dailyRows] = daily;
    const [hourlyRows] = hourly;
    const [itemRows] = topItems;
    const [paymentRows] = paymentMethods;
    const [fulfillmentRows] = fulfillmentSales;
    const [statusRows] = await db.execute(
        `SELECT status, COUNT(*) AS count FROM customer_orders WHERE ${currentFilter} GROUP BY status`
    );
    return {
        period, label: window.label, current, previous,
        daily: dailyRows.map(row => ({ date: row.day, orders: Number(row.orders), sales: Number(row.sales), completed: Number(row.completed || 0) })),
        hourly: hourlyRows.map(row => ({ hour: Number(row.hour), orders: Number(row.orders) })),
        topItems: itemRows.map(row => ({ name: row.name, quantity: Number(row.quantity), revenue: Number(row.revenue) })),
        paymentMethods: paymentRows.map(row => ({ method: row.method || "Unspecified", orders: Number(row.orders), amount: Number(row.amount || 0) })),
        fulfillmentSales: fulfillmentRows.map(row => ({ type: row.type || "Other", orders: Number(row.orders), amount: Number(row.amount || 0) })),
        statusBreakdown: statusRows.map(row => ({ status: row.status, count: Number(row.count) }))
    };
}

const DEFAULT_ADMIN_SETTINGS = {
    general: {
        siteName: "Jolie's Pizza - San Roque", email: "joliespizza@gmail.com",
        contact: "+639978736812", address: "Zone 3, San Isidro St, San Roque, Northern Samar",
        hours: "10:00 AM – 9:00 PM, Monday – Sunday",
        mapEmbedUrl: "https://www.google.com/maps?q=Zone%203%2C%20San%20Isidro%20St%2C%20San%20Roque%2C%20Northern%20Samar&output=embed",
        currency: "Philippine Peso (₱)",
        timezone: "(GMT+08:00) Asia/Manila", dateFormat: "May 20, 2024 (MMM DD, YYYY)"
    },
    system: {},
    design: {
        admin: { accent: "#e3131b", page: "#f7f8fa", sidebar: "#070b0f", radius: "12px" },
        staff: { accent: "#d71920", page: "#f8f9fb", sidebar: "#a90000", radius: "12px" },
        customer: { accent: "#d71920", page: "#ffffff", sidebar: "#d71920", radius: "12px" }
    }
};

async function ensureAdminSettingsSchema() {
    await db.execute(`CREATE TABLE IF NOT EXISTS admin_settings (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        settings_json JSON NOT NULL,
        updated_by_email VARCHAR(190) NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.execute(`INSERT IGNORE INTO admin_settings (id, settings_json) VALUES (1, ?)` , [JSON.stringify(DEFAULT_ADMIN_SETTINGS)]);
}

async function ensureStaffBusinessReportsSchema() {
    await db.execute(`CREATE TABLE IF NOT EXISTS staff_business_reports (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        submitted_by_email VARCHAR(190) NOT NULL,
        period VARCHAR(20) NOT NULL,
        report_json JSON NOT NULL,
        staff_note VARCHAR(1000) NULL,
        status ENUM('submitted','reviewed') NOT NULL DEFAULT 'submitted',
        reviewed_by_email VARCHAR(190) NULL,
        reviewed_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_staff_business_reports_status_date (status, created_at),
        INDEX idx_staff_business_reports_staff_date (submitted_by_email, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function listStaffBusinessReports() {
    const [rows] = await db.execute(`SELECT id, submitted_by_email AS submittedBy, period,
        report_json AS report, staff_note AS note, status, reviewed_by_email AS reviewedBy,
        reviewed_at AS reviewedAt, created_at AS createdAt
        FROM staff_business_reports ORDER BY FIELD(status,'submitted','reviewed'), created_at DESC LIMIT 100`);
    return rows.map(row => ({ ...row, report: typeof row.report === "string" ? JSON.parse(row.report) : row.report }));
}

async function getAdminSettings() {
    const [[row]] = await db.execute("SELECT settings_json FROM admin_settings WHERE id = 1");
    let saved = row?.settings_json || {};
    if (typeof saved === "string") { try { saved = JSON.parse(saved); } catch { saved = {}; } }
    const oldDesign = saved.design || {};
    const general = { ...DEFAULT_ADMIN_SETTINGS.general, ...(saved.general || {}) };
    // Migrate the old settings form's sample-only contact details to the live
    // customer Contact Us information once, while preserving later admin edits.
    if (general.email === "info@joliespizza.com") general.email = DEFAULT_ADMIN_SETTINGS.general.email;
    if (general.contact === "0912 987 6543") general.contact = DEFAULT_ADMIN_SETTINGS.general.contact;
    return {
        general,
        system: saved.system || {},
        design: {
            admin: { ...DEFAULT_ADMIN_SETTINGS.design.admin, ...(oldDesign.admin || oldDesign) },
            staff: { ...DEFAULT_ADMIN_SETTINGS.design.staff, ...(oldDesign.staff || {}) },
            customer: { ...DEFAULT_ADMIN_SETTINGS.design.customer, ...(oldDesign.customer || {}) }
        }
    };
}

async function saveAdminSettings(session, body) {
    const prior = await getAdminSettings();
    const general = body.general && typeof body.general === "object" ? body.general : prior.general;
    const system = body.system && typeof body.system === "object" ? body.system : prior.system;
    const incomingDesign = body.design && typeof body.design === "object" ? body.design : prior.design;
    const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
    const makeTheme = (surface, priorTheme) => {
        const incoming = incomingDesign[surface] && typeof incomingDesign[surface] === "object" ? incomingDesign[surface] : priorTheme;
        return {
            accent: color(incoming.accent, priorTheme.accent),
            page: color(incoming.page, priorTheme.page),
            sidebar: color(incoming.sidebar, priorTheme.sidebar),
            radius: ["8px", "12px", "18px"].includes(incoming.radius) ? incoming.radius : priorTheme.radius
        };
    };
    const design = {
        admin: makeTheme("admin", prior.design.admin),
        staff: makeTheme("staff", prior.design.staff),
        customer: makeTheme("customer", prior.design.customer)
    };
    const mapUrl = cleanText(general.mapEmbedUrl, 1000);
    let validMapUrl = prior.general.mapEmbedUrl;
    try { const parsed = new URL(mapUrl); if (parsed.protocol === "https:" && ["google.com", "www.google.com", "maps.google.com"].includes(parsed.hostname)) validMapUrl = parsed.href; } catch { /* Keep the existing safe map URL. */ }
    const cleaned = {
        general: {
            siteName: cleanText(general.siteName, 120) || prior.general.siteName,
            email: validEmail(cleanText(general.email, 190)) ? cleanText(general.email, 190) : prior.general.email,
            contact: cleanText(general.contact, 40), address: cleanText(general.address, 240),
            hours: cleanText(general.hours, 160), mapEmbedUrl: validMapUrl, currency: cleanText(general.currency, 60),
            timezone: cleanText(general.timezone, 80), dateFormat: cleanText(general.dateFormat, 60)
        },
        system: Object.fromEntries(Object.entries(system).filter(([key, value]) => /^[a-zA-Z0-9_-]{1,60}$/.test(key) && typeof value === "boolean")),
        design
    };
    await db.execute("UPDATE admin_settings SET settings_json = ?, updated_by_email = ? WHERE id = 1", [JSON.stringify(cleaned), session.email]);
    return cleaned;
}

async function getAdminDashboardData(period = "week") {
    const days = period === "today" ? 1 : period === "month" ? 30 : 7;
    const interval = days - 1;
    const [[summary]] = await db.execute(`SELECT COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN payment_status = 'Paid' AND status != 'Cancelled' THEN total ELSE 0 END),0) AS sales,
        SUM(status = 'Completed') AS completed, SUM(status = 'Cancelled') AS cancelled,
        COALESCE(AVG(CASE WHEN status != 'Cancelled' THEN total END),0) AS averageOrderValue
        FROM customer_orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${interval} DAY) AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`);
    const [daily] = await db.execute(`SELECT DATE(created_at) AS date, COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN payment_status='Paid' AND status!='Cancelled' THEN total ELSE 0 END),0) AS sales
        FROM customer_orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${interval} DAY) AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        GROUP BY DATE(created_at) ORDER BY date`);
    const [categories] = await db.execute(`SELECT COALESCE(c.name, 'Other') AS name, SUM(oi.line_total) AS sales
        FROM order_items oi JOIN customer_orders co ON co.id=oi.order_id
        LEFT JOIN products p ON p.name=oi.product_name LEFT JOIN categories c ON c.id=p.category_id
        WHERE co.created_at >= DATE_SUB(CURDATE(), INTERVAL ${interval} DAY) AND co.created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY) AND co.status!='Cancelled'
        GROUP BY c.name ORDER BY sales DESC LIMIT 6`);
    const [topItems] = await db.execute(`SELECT oi.product_name AS name, SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS sales
        FROM order_items oi JOIN customer_orders co ON co.id=oi.order_id WHERE co.created_at >= DATE_SUB(CURDATE(), INTERVAL ${interval} DAY)
        AND co.created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY) AND co.status!='Cancelled' GROUP BY oi.product_name ORDER BY quantity DESC LIMIT 8`);
    const [recentOrders] = await db.execute(`SELECT order_number, customer_name, total, status, created_at FROM customer_orders ORDER BY created_at DESC LIMIT 8`);
    const [payments] = await db.execute(`SELECT COALESCE(payment_method,'Unspecified') AS method, SUM(total) AS amount FROM customer_orders
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${interval} DAY) AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)
        AND payment_status='Paid' AND status!='Cancelled' GROUP BY payment_method ORDER BY amount DESC`);
    return { period, summary: { orders: Number(summary.orders || 0), sales: Number(summary.sales || 0), completed: Number(summary.completed || 0), cancelled: Number(summary.cancelled || 0), averageOrderValue: Number(summary.averageOrderValue || 0) }, daily: daily.map(r => ({ date: r.date, orders: Number(r.orders), sales: Number(r.sales) })), categories: categories.map(r => ({ name: r.name, sales: Number(r.sales || 0) })), topItems: topItems.map(r => ({ name: r.name, quantity: Number(r.quantity || 0), sales: Number(r.sales || 0) })), recentOrders, payments: payments.map(r => ({ method: r.method, amount: Number(r.amount || 0) })) };
}

async function getAdminReportsData(from, to) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : new Date().toISOString().slice(0, 10);
    const [[summary]] = await db.execute(`SELECT COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN payment_status='Paid' AND status!='Cancelled' THEN total ELSE 0 END),0) AS sales,
        COALESCE(AVG(CASE WHEN status!='Cancelled' THEN total END),0) AS averageOrderValue,
        SUM(status='Completed') AS completed, SUM(status='Cancelled') AS cancelled
        FROM customer_orders WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`, [start, end]);
    const [daily] = await db.execute(`SELECT DATE(created_at) AS date, COUNT(*) AS orders,
        COALESCE(SUM(CASE WHEN payment_status='Paid' AND status!='Cancelled' THEN total ELSE 0 END),0) AS sales
        FROM customer_orders WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY) GROUP BY DATE(created_at) ORDER BY date`, [start, end]);
    const [payments] = await db.execute(`SELECT COALESCE(payment_method,'Unspecified') AS method, SUM(total) AS amount FROM customer_orders
        WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY) AND payment_status='Paid' AND status!='Cancelled' GROUP BY payment_method`, [start, end]);
    const [topItems] = await db.execute(`SELECT oi.product_name AS name, SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS sales FROM order_items oi
        JOIN customer_orders co ON co.id=oi.order_id WHERE co.created_at >= ? AND co.created_at < DATE_ADD(?, INTERVAL 1 DAY) AND co.status!='Cancelled'
        GROUP BY oi.product_name ORDER BY quantity DESC LIMIT 10`, [start, end]);
    const [[customers]] = await db.execute(`SELECT COUNT(*) AS total FROM (
        SELECT customer_email, MIN(created_at) AS first_order FROM customer_orders WHERE customer_email IS NOT NULL GROUP BY customer_email
    ) first_orders WHERE first_order >= ? AND first_order < DATE_ADD(?, INTERVAL 1 DAY)`, [start, end]);
    const [[refunds]] = await db.execute(`SELECT COALESCE(SUM(amount),0) AS total FROM payment_records WHERE status='Refunded' AND created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)`, [start, end]);
    return { from: start, to: end, summary: { sales: Number(summary.sales || 0), orders: Number(summary.orders || 0), averageOrderValue: Number(summary.averageOrderValue || 0), completed: Number(summary.completed || 0), cancelled: Number(summary.cancelled || 0), customers: Number(customers.total || 0), refunds: Number(refunds.total || 0) }, daily: daily.map(r => ({ date: r.date, orders: Number(r.orders), sales: Number(r.sales) })), payments: payments.map(r => ({ method: r.method, amount: Number(r.amount || 0) })), topItems: topItems.map(r => ({ name: r.name, quantity: Number(r.quantity || 0), sales: Number(r.sales || 0) })) };
}

async function getAdminOrderHistory({ search = "", status = "", type = "", dateDays = 0, page = 1, pageSize = 10 } = {}) {
    const conditions = [];
    const params = [];

    if (search) {
        conditions.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_email LIKE ? OR customer_phone LIKE ?)");
        const term = `%${search}%`;
        params.push(term, term, term, term);
    }
    if (status) {
        conditions.push("status = ?");
        params.push(status);
    }
    if (type) {
        conditions.push("fulfillment_type = ?");
        params.push(type);
    }
    if ([7, 30].includes(Number(dateDays))) {
        conditions.push(`created_at >= DATE_SUB(NOW(), INTERVAL ${Number(dateDays)} DAY)`);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(50, Math.max(1, Number(pageSize) || 10));
    const offset = (safePage - 1) * safePageSize;

    const [[{ total }]] = await db.execute(
        `SELECT COUNT(*) AS total FROM customer_orders${where}`,
        params
    );
    const [statusCounts] = await db.execute(
        `SELECT status, COUNT(*) AS count FROM customer_orders GROUP BY status`
    );
    const [orders] = await db.execute(
        `SELECT id, order_number, customer_name, customer_email, customer_phone,
                delivery_address, fulfillment_type, pickup_time, pickup_status,
                subtotal, delivery_fee, total, status, payment_method,
                payment_status, created_at
         FROM customer_orders${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...params, safePageSize, offset]
    );

    let itemsByOrderId = new Map();
    if (orders.length) {
        const ids = orders.map(order => order.id);
        const [items] = await db.execute(
            `SELECT order_id, product_name, product_price, quantity, line_total, selected_size
             FROM order_items WHERE order_id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC`,
            ids
        );
        for (const item of items) {
            const list = itemsByOrderId.get(item.order_id) || [];
            list.push({
                name: item.product_name,
                price: Number(item.product_price),
                quantity: Number(item.quantity),
                lineTotal: Number(item.line_total),
                size: item.selected_size
            });
            itemsByOrderId.set(item.order_id, list);
        }
    }

    return {
        orders: orders.map(order => ({
            id: order.id,
            orderNumber: order.order_number,
            customerName: order.customer_name,
            customerEmail: order.customer_email,
            customerPhone: order.customer_phone,
            deliveryAddress: order.delivery_address,
            fulfillmentType: order.fulfillment_type,
            pickupTime: order.pickup_time,
            pickupStatus: order.pickup_status,
            subtotal: Number(order.subtotal),
            deliveryFee: Number(order.delivery_fee),
            total: Number(order.total),
            status: order.status,
            paymentMethod: order.payment_method,
            paymentStatus: order.payment_status,
            createdAt: order.created_at,
            items: itemsByOrderId.get(order.id) || []
        })),
        total: Number(total),
        page: safePage,
        pageSize: safePageSize,
        statusCounts: Object.fromEntries(statusCounts.map(row => [row.status, Number(row.count)]))
    };
}

async function getStaffMenuProducts() {
    const [rows] = await db.execute(
        `SELECT p.id, p.name, p.description, p.price, p.image_url, p.category_id,
                p.is_available, c.name AS category_name
         FROM products p
         INNER JOIN categories c ON c.id = p.category_id
         ORDER BY c.name ASC, p.name ASC`
    );
    return rows.map(product => ({
        ...product,
        is_available: Boolean(product.is_available)
    }));
}

async function getAdminMenuData() {
    const [categories] = await db.execute(
        `SELECT c.id, c.name, c.slug, c.description, c.is_active,
                c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS item_count
         FROM categories c
         ORDER BY c.name ASC`
    );
    const [products] = await db.execute(
        `SELECT p.id, p.name, p.description, p.price, p.image_url, p.tags,
                p.category_id, p.is_available, c.name AS category_name, c.slug AS category_slug
         FROM products p
         INNER JOIN categories c ON c.id = p.category_id
         ORDER BY c.name ASC, p.name ASC`
    );
    return {
        categories: categories.map(category => ({
            id: category.id, name: category.name, slug: category.slug,
            description: category.description || "", isActive: Boolean(category.is_active),
            createdAt: category.created_at, updatedAt: category.updated_at,
            itemCount: Number(category.item_count)
        })),
        products: products.map(product => ({
            id: product.id, name: product.name, description: product.description || "",
            price: Number(product.price), imageUrl: product.image_url, tags: product.tags,
            categoryId: product.category_id, category: product.category_name,
            categorySlug: product.category_slug, isAvailable: Boolean(product.is_available)
        }))
    };
}

function menuSlug(value) {
    return cleanText(value, 150).toLowerCase()
        .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
}

async function ensureMenuManagementColumns() {
    const [columns] = await db.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'categories'`
    );
    const existing = new Set(columns.map(column => column.COLUMN_NAME));
    const additions = [
        ["description", "TEXT NULL"],
        ["is_active", "BOOLEAN NOT NULL DEFAULT TRUE"],
        ["created_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"],
        ["updated_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"]
    ];
    for (const [name, definition] of additions) {
        if (!existing.has(name)) {
            await db.execute(`ALTER TABLE categories ADD COLUMN ${name} ${definition}`);
        }
    }
}

async function getInventoryItems() {
    const [rows] = await db.execute(
        `SELECT id, name, category, unit, current_stock, low_stock_threshold,
                is_active, updated_at
         FROM inventory_items
         ORDER BY name ASC`
    );
    return rows.map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit,
        stock: Number(item.current_stock),
        threshold: Number(item.low_stock_threshold),
        inactive: !Boolean(item.is_active),
        updated: item.updated_at
    }));
}

async function ensureInventoryTables() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS inventory_items (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(150) NOT NULL,
            category VARCHAR(80) NOT NULL DEFAULT 'Ingredients',
            unit VARCHAR(30) NOT NULL,
            current_stock DECIMAL(12,3) NOT NULL DEFAULT 0,
            low_stock_threshold DECIMAL(12,3) NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_inventory_items_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await ensureInventoryItemColumns();
    await db.execute(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            inventory_item_id INT UNSIGNED NOT NULL,
            movement_type ENUM('stock_in', 'stock_out') NOT NULL,
            quantity DECIMAL(12,3) NOT NULL,
            note VARCHAR(500) NULL,
            performed_by_email VARCHAR(190) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_inventory_movements_item_date (inventory_item_id, created_at),
            CONSTRAINT fk_inventory_movements_item FOREIGN KEY (inventory_item_id)
                REFERENCES inventory_items(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS inventory_stock_requests (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            inventory_item_id INT UNSIGNED NOT NULL,
            requested_by_email VARCHAR(190) NOT NULL,
            requested_quantity DECIMAL(12,3) NOT NULL,
            note VARCHAR(500) NULL,
            status ENUM('pending', 'fulfilled', 'rejected') NOT NULL DEFAULT 'pending',
            responded_by_email VARCHAR(190) NULL,
            response_note VARCHAR(500) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            fulfilled_at TIMESTAMP NULL DEFAULT NULL,
            INDEX idx_inventory_requests_status_date (status, created_at),
            INDEX idx_inventory_requests_staff_date (requested_by_email, created_at),
            CONSTRAINT fk_inventory_requests_item FOREIGN KEY (inventory_item_id)
                REFERENCES inventory_items(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

async function ensureInventoryItemColumns() {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items'`
    );
    const existing = new Set(rows.map(row => row.COLUMN_NAME));
    const additions = [
        { name: "name", definition: "VARCHAR(150) NULL", aliases: ["item_name", "ingredient_name", "product_name", "inventory_name"] },
        { name: "category", definition: "VARCHAR(80) NOT NULL DEFAULT 'Ingredients'", aliases: ["item_category", "ingredient_category"] },
        { name: "unit", definition: "VARCHAR(30) NOT NULL DEFAULT 'unit'", aliases: ["unit_name", "stock_unit"] },
        { name: "current_stock", definition: "DECIMAL(12,3) NOT NULL DEFAULT 0", aliases: ["stock", "stock_quantity", "quantity_in_stock", "quantity"] },
        { name: "low_stock_threshold", definition: "DECIMAL(12,3) NOT NULL DEFAULT 1", aliases: ["minimum_stock", "reorder_level", "low_stock_limit"] },
        { name: "is_active", definition: "BOOLEAN NOT NULL DEFAULT TRUE", aliases: ["active", "is_available"] },
        { name: "updated_at", definition: "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP", aliases: ["updated_on", "modified_at"] }
    ];

    for (const column of additions) {
        if (existing.has(column.name)) continue;
        await db.execute(`ALTER TABLE inventory_items ADD COLUMN \`${column.name}\` ${column.definition}`);
        const source = column.aliases.find(alias => existing.has(alias));
        if (source) {
            await db.execute(`UPDATE inventory_items SET \`${column.name}\` = COALESCE(\`${source}\`, \`${column.name}\`)`);
        } else if (column.name === "name" && existing.has("id")) {
            await db.execute("UPDATE inventory_items SET name = CONCAT('Ingredient ', id) WHERE name IS NULL OR name = ''");
        }
        existing.add(column.name);
    }

    const appColumns = new Set([
        "id", "name", "category", "unit", "current_stock", "low_stock_threshold",
        "is_active", "created_at", "updated_at"
    ]);
    const [legacyColumns] = await db.execute(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                COLUMN_KEY, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items'`
    );
    for (const column of legacyColumns) {
        if (appColumns.has(column.COLUMN_NAME) || column.IS_NULLABLE === "YES" ||
            column.COLUMN_DEFAULT !== null || column.COLUMN_KEY === "PRI" ||
            /auto_increment|generated/i.test(column.EXTRA || "")) continue;
        const charset = column.CHARACTER_SET_NAME ? ` CHARACTER SET ${column.CHARACTER_SET_NAME}` : "";
        const collation = column.COLLATION_NAME ? ` COLLATE ${column.COLLATION_NAME}` : "";
        await db.execute(
            `ALTER TABLE inventory_items MODIFY COLUMN \`${column.COLUMN_NAME}\` ${column.COLUMN_TYPE}${charset}${collation} NULL`
        );
    }

    await db.execute(
        "UPDATE inventory_items SET name = CONCAT('Ingredient ', id) WHERE name IS NULL OR TRIM(name) = ''"
    );
    await db.execute(
        "ALTER TABLE inventory_items MODIFY COLUMN name VARCHAR(150) NOT NULL"
    );
}

async function seedInventoryCatalog() {
    const ingredients = [
        ["All-Purpose Flour", "Dough", "kg", 5],
        ["Mozzarella Cheese", "Dairy", "kg", 2],
        ["Tomato Sauce", "Sauce", "L", 2],
        ["Pepperoni", "Meat", "kg", 1],
        ["Mushrooms", "Vegetables", "kg", 1],
        ["Onions", "Vegetables", "kg", 1],
        ["Bell Peppers", "Vegetables", "kg", 1],
        ["Black Olives", "Toppings", "kg", 1],
        ["Pineapple", "Toppings", "kg", 1],
        ["Ham", "Meat", "kg", 1],
        ["Chicken Breast", "Meat", "kg", 2],
        ["Bacon", "Meat", "kg", 1],
        ["Parmesan Cheese", "Dairy", "kg", 0.5],
        ["Yeast", "Dough", "g", 100],
        ["Salt", "Sides", "kg", 0.5],
        ["Sugar", "Sides", "kg", 1],
        ["Olive Oil", "Sides", "L", 1],
        ["Pasta", "Sides", "kg", 2],
        ["Milk", "Dairy", "L", 2],
        ["Garlic", "Vegetables", "kg", 0.5]
    ];
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [existingRows] = await connection.execute("SELECT id, name FROM inventory_items ORDER BY id FOR UPDATE");
        if (existingRows.length === 0) {
            for (const [name, category, unit, threshold] of ingredients) {
                await connection.execute(
                    `INSERT INTO inventory_items (name, category, unit, current_stock, low_stock_threshold)
                     VALUES (?, ?, ?, 0, ?)`,
                    [name, category, unit, threshold]
                );
            }
        } else if (existingRows.every(item => /^Ingredient\s+\d+$/i.test(item.name))) {
            for (const [index, item] of existingRows.entries()) {
                const ingredient = ingredients[index];
                if (!ingredient) break;
                const [name, category, unit, threshold] = ingredient;
                await connection.execute(
                    `UPDATE inventory_items
                     SET name = ?, category = ?, unit = ?, low_stock_threshold = ?
                     WHERE id = ?`,
                    [name, category, unit, threshold, item.id]
                );
            }
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function createInventoryStockRequest(session, body) {
    const itemName = cleanText(body.itemName, 150);
    const category = cleanText(body.category, 80) || "Ingredients";
    const unit = cleanText(body.unit, 30);
    const quantity = Number(body.quantity);
    const note = cleanText(body.note, 500) || null;
    const itemId = Number(body.itemId);

    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
        return { status: 400, data: { success: false, message: "Enter a requested quantity greater than zero." } };
    }
    if (!itemId && (!itemName || !unit)) {
        return { status: 400, data: { success: false, message: "Choose an inventory item or enter its name and unit." } };
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        let selectedItemId = itemId;
        if (itemId) {
            const [items] = await connection.execute(
                "SELECT id FROM inventory_items WHERE id = ? AND is_active = TRUE FOR UPDATE",
                [itemId]
            );
            if (!items.length) {
                await connection.rollback();
                return { status: 404, data: { success: false, message: "Inventory item not found." } };
            }
        } else {
            await connection.execute(
                `INSERT INTO inventory_items (name, category, unit, current_stock)
                 VALUES (?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                [itemName, category, unit]
            );
            const [items] = await connection.execute(
                "SELECT id FROM inventory_items WHERE name = ? FOR UPDATE",
                [itemName]
            );
            selectedItemId = items[0]?.id;
        }

        if (!selectedItemId) {
            await connection.rollback();
            return { status: 400, data: { success: false, message: "Could not identify the inventory item." } };
        }
        const [insert] = await connection.execute(
            `INSERT INTO inventory_stock_requests
                (inventory_item_id, requested_by_email, requested_quantity, note)
             VALUES (?, ?, ?, ?)`,
            [selectedItemId, session.email, quantity, note]
        );
        await connection.commit();
        return { status: 201, data: { success: true, requestId: insert.insertId, message: "Stock request sent to the admin." } };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function getInventoryRequests({ pendingOnly = false, email = null } = {}) {
    const conditions = [];
    const params = [];
    if (pendingOnly) conditions.push("r.status = 'pending'");
    if (email) {
        conditions.push("r.requested_by_email = ?");
        params.push(email);
    }
    const [rows] = await db.execute(
        `SELECT r.id, r.inventory_item_id AS itemId, i.name AS itemName,
                i.category, i.unit, i.current_stock AS currentStock,
                r.requested_by_email AS requestedBy, r.requested_quantity AS quantity,
                r.note, r.status, r.responded_by_email AS respondedBy,
                r.response_note AS responseNote, r.created_at AS createdAt,
                r.fulfilled_at AS fulfilledAt
         FROM inventory_stock_requests r
         INNER JOIN inventory_items i ON i.id = r.inventory_item_id
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY (r.status = 'pending') DESC, r.created_at DESC
         LIMIT 200`,
        params
    );
    return rows.map(row => ({ ...row, quantity: Number(row.quantity), currentStock: Number(row.currentStock) }));
}

async function recordInventoryMovement(session, body) {
    const itemId = Number(body.itemId);
    const type = body.movementType;
    const quantity = Number(body.quantity);
    const note = cleanText(body.note, 500) || null;
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || !["stock_in", "stock_out"].includes(type)) {
        return { status: 400, data: { success: false, message: "Choose a valid inventory item and stock movement." } };
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
        return { status: 400, data: { success: false, message: "Enter a quantity greater than zero." } };
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [items] = await connection.execute(
            "SELECT current_stock, is_active FROM inventory_items WHERE id = ? FOR UPDATE",
            [itemId]
        );
        const item = items[0];
        if (!item || !item.is_active) {
            await connection.rollback();
            return { status: 404, data: { success: false, message: "Active inventory item not found." } };
        }
        const stock = Number(item.current_stock);
        if (type === "stock_out" && quantity > stock) {
            await connection.rollback();
            return { status: 409, data: { success: false, message: `Only ${stock} units are currently in stock.` } };
        }
        const delta = type === "stock_in" ? quantity : -quantity;
        await connection.execute(
            "UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?",
            [delta, itemId]
        );
        await connection.execute(
            `INSERT INTO inventory_movements
                (inventory_item_id, movement_type, quantity, note, performed_by_email)
             VALUES (?, ?, ?, ?, ?)`,
            [itemId, type, quantity, note, session.email]
        );
        await connection.commit();
        return { status: 200, data: { success: true, message: type === "stock_in" ? "Stock received and recorded." : "Stock out recorded." } };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function fulfillInventoryRequest(session, requestId, quantityInput, responseNoteInput) {
    const quantity = Number(quantityInput);
    const responseNote = cleanText(responseNoteInput, 500) || null;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [requests] = await connection.execute(
            `SELECT id, inventory_item_id, requested_quantity, status
             FROM inventory_stock_requests WHERE id = ? FOR UPDATE`,
            [requestId]
        );
        const request = requests[0];
        if (!request || request.status !== "pending") {
            await connection.rollback();
            return { status: 404, data: { success: false, message: "Pending stock request not found." } };
        }
        const acceptedQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : Number(request.requested_quantity);
        if (acceptedQuantity > 100000) {
            await connection.rollback();
            return { status: 400, data: { success: false, message: "Enter a valid received quantity." } };
        }
        const [items] = await connection.execute(
            "SELECT id FROM inventory_items WHERE id = ? AND is_active = TRUE FOR UPDATE",
            [request.inventory_item_id]
        );
        if (!items.length) {
            await connection.rollback();
            return { status: 404, data: { success: false, message: "Inventory item not found." } };
        }
        await connection.execute(
            "UPDATE inventory_items SET current_stock = current_stock + ? WHERE id = ?",
            [acceptedQuantity, request.inventory_item_id]
        );
        await connection.execute(
            `INSERT INTO inventory_movements
                (inventory_item_id, movement_type, quantity, note, performed_by_email)
             VALUES (?, 'stock_in', ?, ?, ?)`,
            [request.inventory_item_id, acceptedQuantity, responseNote || `Fulfilled staff request #${request.id}`, session.email]
        );
        await connection.execute(
            `UPDATE inventory_stock_requests
             SET status = 'fulfilled', responded_by_email = ?, response_note = ?, fulfilled_at = NOW()
             WHERE id = ?`,
            [session.email, responseNote, request.id]
        );
        await connection.commit();
        return { status: 200, data: { success: true, message: "Request fulfilled and stock-in recorded." } };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function cancelCustomerOrder(orderNumber, customerEmail) {
    const [orders] = await db.execute(
        `SELECT id, status, payment_method, payment_status, fulfillment_type
         FROM customer_orders
         WHERE order_number = ? AND customer_email = ?
         LIMIT 1`,
        [orderNumber, customerEmail]
    );
    if (orders.length === 0) {
        return { status: 404, data: { success: false, message: "Order not found for this customer account." } };
    }

    const order = orders[0];
    if (order.status !== "Pending") {
        return {
            status: 409,
            data: {
                success: false,
                message: order.status === "Confirmed"
                    ? "The restaurant has claimed this order. Please contact the restaurant to cancel it."
                    : `This order can no longer be cancelled because it is ${order.status.toLowerCase()}.`
            }
        };
    }
    if (order.payment_method === "GCash" && order.payment_status === "Paid") {
        return {
            status: 409,
            data: {
                success: false,
                message: "This GCash order is already paid. Please contact the restaurant to arrange cancellation and refund."
            }
        };
    }

    const [result] = await db.execute(
        `UPDATE customer_orders
         SET status = 'Cancelled',
             payment_status = CASE
                 WHEN payment_method = 'GCash' AND payment_status != 'Paid' THEN 'Cancelled'
                 ELSE payment_status
             END
         WHERE id = ? AND status = 'Pending'`,
        [order.id]
    );
    if (result.affectedRows === 0) {
        return {
            status: 409,
            data: { success: false, message: "The order status changed before cancellation could be saved. Refresh the order and try again." }
        };
    }
    if (order.fulfillment_type === "delivery") {
        await recordDeliveryStatusHistory(order.id, "Cancelled", customerEmail, "Cancelled by customer.");
    }
    return {
        status: 200,
        data: {
            success: true,
            status: "Cancelled",
            paymentStatus: order.payment_method === "GCash" ? "Cancelled" : order.payment_status,
            message: "Your order has been cancelled."
        }
    };
}

async function recordDeliveryStatusHistory(orderId, status, changedByEmail = null, note = null) {
    await db.execute(
        `INSERT INTO delivery_status_history (order_id, status, changed_by_email, note)
         VALUES (?, ?, ?, ?)`,
        [orderId, status, changedByEmail, note]
    );
}

async function cancelStaffOrder(orderNumber, changedByEmail = null) {
    const [existing] = await db.execute(
        "SELECT id, fulfillment_type FROM customer_orders WHERE order_number = ? LIMIT 1",
        [orderNumber]
    );
    const [result] = await db.execute(
        `UPDATE customer_orders
         SET status = 'Cancelled',
             payment_status = CASE
                 WHEN payment_method = 'GCash' AND payment_status != 'Paid' THEN 'Cancelled'
                 ELSE payment_status
             END
         WHERE order_number = ?
           AND status IN ('Pending', 'Confirmed', 'Preparing', 'Out for Delivery')`,
        [orderNumber]
    );
    if (result.affectedRows > 0) {
        if (existing[0]?.fulfillment_type === "delivery") {
            await recordDeliveryStatusHistory(existing[0].id, "Cancelled", changedByEmail, "Cancelled by staff.");
        }
        return {
            status: 200,
            data: { success: true, status: "Cancelled", message: "Order cancelled." }
        };
    }
    const [orders] = await db.execute(
        "SELECT status FROM customer_orders WHERE order_number = ? LIMIT 1",
        [orderNumber]
    );
    return orders.length
        ? { status: 409, data: { success: false, message: `This order cannot be cancelled because it is ${String(orders[0].status).toLowerCase()}.` } }
        : { status: 404, data: { success: false, message: "Order not found." } };
}

async function getStaffDeliveries() {
    const [orders] = await db.execute(
        `SELECT
            co.id,
            co.order_number,
            co.customer_name,
            co.customer_phone,
            co.delivery_address,
            co.total,
            co.status,
            co.payment_method,
            co.payment_status,
            co.created_at,
            da.rider_name AS assigned_rider_name,
            da.rider_phone AS assigned_rider_phone,
            da.vehicle_description,
            da.license_plate
         FROM customer_orders co
         LEFT JOIN delivery_assignments da ON da.order_id = co.id
         WHERE co.fulfillment_type = 'delivery'
           AND co.status IN ('Pending', 'Confirmed', 'Preparing', 'Out for Delivery')
         ORDER BY co.created_at ASC, co.id ASC`
    );

    if (orders.length === 0) return [];

    const trackingByOrderId = new Map();
    try {
        const deliveryOrderIds = orders.map(order => order.id);
        const placeholders = deliveryOrderIds.map(() => "?").join(",");
        const [schemaColumns] = await db.execute(
            `SELECT TABLE_NAME, COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'delivery_tracking'`
        );
        const gpsColumns = new Set(schemaColumns
            .filter(column => column.TABLE_NAME === "delivery_tracking")
            .map(column => column.COLUMN_NAME));
        if (gpsColumns.has("order_id")) {
            const gpsColumn = (name, alias = name) => gpsColumns.has(name)
                ? `dt.${name} AS ${alias}`
                : `NULL AS ${alias}`;
            const whereParts = [`dt.order_id IN (${placeholders})`];
            if (gpsColumns.has("tracking_active")) whereParts.push("dt.tracking_active = TRUE");
            const [trackingRows] = await db.execute(
                `SELECT dt.order_id,
                        ${gpsColumn("rider_email")},
                        ${gpsColumn("latitude")},
                        ${gpsColumn("longitude")},
                        ${gpsColumn("accuracy")},
                        ${gpsColumn("speed")},
                        ${gpsColumn("heading")},
                        ${gpsColumn("updated_at")}
                 FROM delivery_tracking dt
                 WHERE ${whereParts.join(" AND ")}`,
                deliveryOrderIds
            );
            for (const row of trackingRows) trackingByOrderId.set(row.order_id, row);
        } else if (!warnedAboutOptionalGpsSchema) {
            console.warn("delivery_tracking has no order_id column; rider GPS is skipped until its schema is corrected.");
            warnedAboutOptionalGpsSchema = true;
        }
    } catch (error) {
        // Rider assignment and dispatch must remain usable if the optional GPS schema
        // has not been installed yet. The page will simply show GPS as unavailable.
        if (!warnedAboutOptionalGpsSchema) {
            console.error("Could not load optional rider GPS data; dispatch can continue without GPS:", error.message || error.code);
            warnedAboutOptionalGpsSchema = true;
        }
    }

    const orderIds = orders.map(order => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const [items] = await db.execute(
        `SELECT order_id, product_name, quantity, product_price
         FROM order_items
         WHERE order_id IN (${placeholders})
         ORDER BY id ASC`,
        orderIds
    );
    const itemsByOrderId = new Map();

    for (const item of items) {
        const orderItems = itemsByOrderId.get(item.order_id) || [];
        orderItems.push({
            name: item.product_name,
            qty: Number(item.quantity),
            price: Number(item.product_price)
        });
        itemsByOrderId.set(item.order_id, orderItems);
    }

    return orders.map(order => {
        const gps = trackingByOrderId.get(order.id);
        return {
            id: order.order_number,
            customer: order.customer_name,
            phone: order.customer_phone,
            address: order.delivery_address,
            rider: order.assigned_rider_name || gps?.gps_rider_name || "",
            riderPhone: order.assigned_rider_phone || gps?.gps_rider_phone || "",
            vehicleDescription: order.vehicle_description || "",
            licensePlate: order.license_plate || "",
            riderEmail: gps?.rider_email || "",
            status: order.status,
            eta: "Not available",
            createdAt: order.created_at,
            orderTime: new Date(order.created_at).toLocaleTimeString("en-PH", {
                hour: "numeric",
                minute: "2-digit"
            }),
            payment: order.payment_method,
            paymentStatus: order.payment_status,
            total: Number(order.total),
            rating: 0,
            note: "",
            items: itemsByOrderId.get(order.id) || [],
            location: !gps || gps.latitude === null
                ? null
                : {
                    latitude: Number(gps.latitude),
                    longitude: Number(gps.longitude),
                    accuracy: gps.accuracy === null ? null : Number(gps.accuracy),
                    speed: gps.speed === null ? null : Number(gps.speed),
                    heading: gps.heading === null ? null : Number(gps.heading),
                    updatedAt: gps.updated_at
                }
        };
    });
}

async function getAdminDeliveryHistory(orderNumber = "") {
    const params = [];
    let where = "WHERE co.fulfillment_type = 'delivery'";
    if (orderNumber) {
        where += " AND co.order_number = ?";
        params.push(orderNumber);
    }
    const [orders] = await db.execute(
        `SELECT co.id, co.order_number, co.customer_name, co.customer_email,
                co.customer_phone, co.delivery_address, co.subtotal, co.delivery_fee,
                co.total, co.status, co.payment_method, co.payment_status, co.created_at,
                da.rider_name, da.rider_phone, da.vehicle_description, da.license_plate,
                da.assigned_by_email, da.created_at AS assigned_at, da.updated_at AS assignment_updated_at
         FROM customer_orders co
         LEFT JOIN delivery_assignments da ON da.order_id = co.id
         ${where}
         ORDER BY co.created_at DESC, co.id DESC
         LIMIT 500`,
        params
    );
    if (!orders.length) return [];

    const ids = orders.map(order => order.id);
    const placeholders = ids.map(() => "?").join(",");
    const [items] = await db.execute(
        `SELECT order_id, product_name, product_price, quantity, line_total
         FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`, ids
    );
    const itemsByOrderId = new Map();
    for (const item of items) {
        const list = itemsByOrderId.get(String(item.order_id)) || [];
        list.push({ name: item.product_name, price: Number(item.product_price), quantity: Number(item.quantity), lineTotal: Number(item.line_total) });
        itemsByOrderId.set(String(item.order_id), list);
    }

    const gpsByOrderId = new Map();
    try {
        const [columns] = await db.execute(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delivery_tracking'`
        );
        const gpsColumns = new Set(columns.map(column => column.COLUMN_NAME));
        if (gpsColumns.has("order_id") && gpsColumns.has("latitude") && gpsColumns.has("longitude")) {
            const trackingActive = gpsColumns.has("tracking_active") ? " AND tracking_active = TRUE" : "";
            const updated = gpsColumns.has("updated_at") ? "updated_at" : "NULL AS updated_at";
            const [locations] = await db.execute(
                `SELECT order_id, latitude, longitude, ${updated}
                 FROM delivery_tracking WHERE order_id IN (${placeholders})${trackingActive}`,
                ids
            );
            for (const location of locations) gpsByOrderId.set(String(location.order_id), location);
        }
    } catch (error) {
        if (!warnedAboutOptionalGpsSchema) {
            console.warn("Could not load optional rider GPS data for admin history:", error.code || error.message);
            warnedAboutOptionalGpsSchema = true;
        }
    }

    return orders.map(order => {
        const location = gpsByOrderId.get(String(order.id));
        return {
            id: order.id,
            orderNumber: order.order_number,
            customerName: order.customer_name,
            customerEmail: order.customer_email,
            customerPhone: order.customer_phone,
            address: order.delivery_address,
            rider: order.rider_name || "",
            riderPhone: order.rider_phone || "",
            vehicleDescription: order.vehicle_description || "",
            licensePlate: order.license_plate || "",
            assignedBy: order.assigned_by_email || "",
            assignedAt: order.assigned_at,
            assignmentUpdatedAt: order.assignment_updated_at,
            status: order.status,
            createdAt: order.created_at,
            subtotal: Number(order.subtotal),
            deliveryFee: Number(order.delivery_fee),
            total: Number(order.total),
            paymentMethod: order.payment_method,
            paymentStatus: order.payment_status,
            items: itemsByOrderId.get(String(order.id)) || [],
            location: location && location.latitude !== null && location.longitude !== null
                ? { latitude: Number(location.latitude), longitude: Number(location.longitude), updatedAt: location.updated_at }
                : null
        };
    });
}

async function getCustomerDeliveryLocation(orderNumber, email) {
    // Older installs may have a delivery_tracking table created before the GPS
    // metadata columns were added. Resolve its available columns first so one
    // missing optional field cannot break the customer's delivery view.
    const [trackingSchema] = await db.execute(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delivery_tracking'`
    );
    const trackingColumns = new Set(trackingSchema.map(column => column.COLUMN_NAME));
    const trackingColumn = name => trackingColumns.has(name) ? `dt.${name}` : `NULL AS ${name}`;
    const hasTracking = trackingColumns.has("order_id");
    const trackingJoin = hasTracking
        ? `LEFT JOIN delivery_tracking dt
            ON dt.order_id = co.id${trackingColumns.has("tracking_active") ? " AND dt.tracking_active = TRUE" : ""}`
        : "LEFT JOIN (SELECT NULL AS order_id, NULL AS rider_email, NULL AS latitude, NULL AS longitude, NULL AS accuracy, NULL AS speed, NULL AS heading, NULL AS updated_at) dt ON 1 = 0";
    const riderJoin = hasTracking && trackingColumns.has("rider_email")
        ? "LEFT JOIN users u ON u.email = dt.rider_email"
        : "LEFT JOIN users u ON 1 = 0";
    const [rows] = await db.execute(
        `SELECT
            co.order_number,
            co.status,
            co.fulfillment_type,
            co.pickup_status,
            co.delivery_address,
            da.rider_name,
            da.rider_phone,
            da.vehicle_description,
            da.license_plate,
            ${trackingColumn("latitude")},
            ${trackingColumn("longitude")},
            ${trackingColumn("accuracy")},
            ${trackingColumn("speed")},
            ${trackingColumn("heading")},
            ${trackingColumn("updated_at")},
            u.full_name AS gps_rider_name
         FROM customer_orders co
         LEFT JOIN delivery_assignments da ON da.order_id = co.id
         ${trackingJoin}
         ${riderJoin}
         WHERE co.order_number = ? AND co.customer_email = ?
         LIMIT 1`,
        [orderNumber, email]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
        orderNumber: row.order_number,
        orderStatus: row.status,
        fulfillmentType: row.fulfillment_type,
        pickupStatus: row.pickup_status || "scheduled",
        deliveryAddress: row.delivery_address,
        rider: row.rider_name || row.gps_rider_name || null,
        riderPhone: row.rider_phone || null,
        vehicleDescription: row.vehicle_description || null,
        licensePlate: row.license_plate || null,
        location: row.latitude === null
            ? null
            : {
                latitude: Number(row.latitude),
                longitude: Number(row.longitude),
                accuracy: row.accuracy === null ? null : Number(row.accuracy),
                speed: row.speed === null ? null : Number(row.speed),
                heading: row.heading === null ? null : Number(row.heading),
                updatedAt: row.updated_at
            }
    };
}

async function saveDeliveryAssignment(orderNumber, assignedByEmail, body) {
    const riderName = cleanText(body.riderName, 190);
    const riderPhone = cleanText(body.riderPhone, 30);
    const vehicleDescription = cleanText(body.vehicleDescription, 100);
    const licensePlate = cleanText(body.licensePlate, 30);
    if (!riderName || !riderPhone) {
        return { status: 400, data: { success: false, message: "Rider name and phone are required." } };
    }
    const [orders] = await db.execute(
        "SELECT id, status, fulfillment_type FROM customer_orders WHERE order_number = ? LIMIT 1",
        [orderNumber]
    );
    if (!orders.length) return { status: 404, data: { success: false, message: "Order not found." } };
    if (["Completed", "Cancelled"].includes(orders[0].status)) {
        return { status: 409, data: { success: false, message: "Rider details cannot be changed for a completed or cancelled order." } };
    }
    await db.execute(
        `INSERT INTO delivery_assignments
            (order_id, assigned_by_email, rider_name, rider_phone, vehicle_description, license_plate)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            assigned_by_email = VALUES(assigned_by_email),
            rider_name = VALUES(rider_name), rider_phone = VALUES(rider_phone),
            vehicle_description = VALUES(vehicle_description), license_plate = VALUES(license_plate)`,
        [orders[0].id, assignedByEmail, riderName, riderPhone, vehicleDescription || null, licensePlate || null]
    );
    if (orders[0].fulfillment_type === "delivery") {
        await recordDeliveryStatusHistory(orders[0].id, "Rider Assigned", assignedByEmail, `Rider assigned: ${riderName}.`);
    }
    return { status: 200, data: { success: true, message: "Rider assignment saved." } };
}

async function saveDeliveryLocation(orderNumber, riderEmail, body) {
    const latitude = body.latitude;
    const longitude = body.longitude;
    const accuracy = body.accuracy == null ? null : Number(body.accuracy);
    const speed = body.speed == null ? null : Number(body.speed);
    const heading = body.heading == null ? null : Number(body.heading);

    if (
        typeof latitude !== "number" ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        typeof longitude !== "number" ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180 ||
        (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 999999.99)) ||
        (speed !== null && (!Number.isFinite(speed) || speed < 0 || speed > 999999.99)) ||
        (heading !== null && (!Number.isFinite(heading) || heading < 0 || heading > 360))
    ) {
        return {
            status: 400,
            data: { success: false, message: "The GPS location data is invalid." }
        };
    }

    if (!isWithinDeliveryArea(latitude, longitude)) {
        return {
            status: 400,
            data: {
                success: false,
                message: "Live delivery tracking is limited to San Roque and Pambujan, Northern Samar. GPS sharing was not started because this location is outside the service area."
            }
        };
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [orders] = await connection.execute(
            `SELECT id, status
             FROM customer_orders
             WHERE order_number = ?
             FOR UPDATE`,
            [orderNumber]
        );

        if (orders.length === 0) {
            await connection.rollback();
            return {
                status: 404,
                data: { success: false, message: "Order not found." }
            };
        }

        if (orders[0].status !== "Out for Delivery") {
            await connection.rollback();
            return {
                status: 409,
                data: {
                    success: false,
                    message: "GPS sharing is available only while the order is out for delivery."
                }
            };
        }

        const [existingRows] = await connection.execute(
            `SELECT rider_email, tracking_active, updated_at
             FROM delivery_tracking
             WHERE order_id = ?
             FOR UPDATE`,
            [orders[0].id]
        );
        const existing = existingRows[0];
        const isStale = existing &&
            Date.now() - new Date(existing.updated_at).getTime() > 2 * 60 * 1000;

        if (
            existing?.tracking_active &&
            existing.rider_email !== riderEmail &&
            !isStale
        ) {
            await connection.rollback();
            return {
                status: 409,
                data: {
                    success: false,
                    message: "Another rider is already sharing GPS for this order."
                }
            };
        }

        await connection.execute(
            `INSERT INTO delivery_tracking
                (order_id, rider_email, latitude, longitude, accuracy, speed, heading, tracking_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)
             ON DUPLICATE KEY UPDATE
                rider_email = VALUES(rider_email),
                latitude = VALUES(latitude),
                longitude = VALUES(longitude),
                accuracy = VALUES(accuracy),
                speed = VALUES(speed),
                heading = VALUES(heading),
                tracking_active = TRUE,
                updated_at = CURRENT_TIMESTAMP`,
            [
                orders[0].id,
                riderEmail,
                latitude,
                longitude,
                accuracy,
                speed,
                heading
            ]
        );
        await connection.commit();

        return {
            status: 200,
            data: {
                success: true,
                message: "GPS location updated.",
                updatedAt: new Date().toISOString()
            }
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function advanceCustomerOrder(orderNumber, nextStatus, changedByEmail = null) {
    if (nextStatus === "Cancelled") {
        return cancelStaffOrder(orderNumber, changedByEmail);
    }
    let previousStatus = {
        Confirmed: "Pending",
        Preparing: "Confirmed",
        "Out for Delivery": "Preparing",
        Completed: "Preparing"
    }[nextStatus];
    if (!previousStatus) {
        return {
            status: 400,
            data: { success: false, message: "Invalid order status transition." }
        };
    }

    const [orders] = await db.execute(
        `SELECT co.id, co.status, co.payment_method, co.payment_status, co.fulfillment_type,
                da.rider_name
         FROM customer_orders co
         LEFT JOIN delivery_assignments da ON da.order_id = co.id
         WHERE order_number = ?
         LIMIT 1`,
        [orderNumber]
    );
    if (orders.length === 0) {
        return {
            status: 404,
            data: { success: false, message: "Order not found." }
        };
    }
    if (nextStatus === "Completed" && orders[0].fulfillment_type === "delivery") {
        previousStatus = "Out for Delivery";
    } else if (nextStatus === "Completed" && orders[0].fulfillment_type !== "pickup") {
        return {
            status: 400,
            data: { success: false, message: "Only a pickup order can be marked picked up this way." }
        };
    }
    if (nextStatus === "Out for Delivery" &&
        (orders[0].fulfillment_type === "pickup" || !orders[0].rider_name)) {
        return {
            status: 409,
            data: { success: false, message: orders[0].fulfillment_type === "pickup"
                ? "Pickup orders cannot be dispatched for delivery."
                : "Assign a rider before marking this order ready for delivery." }
        };
    }
    if (orders[0].status !== previousStatus) {
        return {
            status: 409,
            data: {
                success: false,
                message: `This order cannot move to ${nextStatus} from ${orders[0].status}.`
            }
        };
    }
    if (
        nextStatus === "Confirmed" &&
        orders[0].payment_method === "GCash" &&
        orders[0].payment_status !== "Paid"
    ) {
        return {
            status: 409,
            data: {
                success: false,
                message: "Wait for the GCash payment to be marked Paid before confirming this order."
            }
        };
    }

    const [updateResult] = await db.execute(
        `UPDATE customer_orders
         SET status = ?, pickup_status = IF(? = 'Completed' AND fulfillment_type = 'pickup', 'picked_up', pickup_status)
         WHERE order_number = ? AND status = ?`,
        [nextStatus, nextStatus, orderNumber, previousStatus]
    );

    if (updateResult.affectedRows > 0) {
        if (orders[0].fulfillment_type === "delivery") {
            await recordDeliveryStatusHistory(orders[0].id, nextStatus, changedByEmail, null);
        }
        return {
            status: 200,
            data: {
                success: true,
                status: nextStatus,
                message: `Order status updated to ${nextStatus}.`
            }
        };
    }

    const [currentOrders] = await db.execute(
        `SELECT status
         FROM customer_orders
         WHERE order_number = ?
         LIMIT 1`,
        [orderNumber]
    );
    if (currentOrders.length === 0) {
        return {
            status: 404,
            data: { success: false, message: "Order not found." }
        };
    }

    return {
        status: 409,
        data: {
            success: false,
            message: `This order cannot move to ${nextStatus} from ${currentOrders[0].status}.`
        }
    };
}

async function markPickupOrderReady(orderNumber) {
    const [result] = await db.execute(
        `UPDATE customer_orders
         SET pickup_status = 'ready'
         WHERE order_number = ?
           AND fulfillment_type = 'pickup'
           AND status = 'Preparing'
           AND pickup_status <> 'picked_up'`,
        [orderNumber]
    );
    if (result.affectedRows) {
        return { status: 200, data: { success: true, message: "Order is ready for customer pickup." } };
    }
    const [orders] = await db.execute(
        `SELECT status, fulfillment_type, pickup_status FROM customer_orders WHERE order_number = ? LIMIT 1`,
        [orderNumber]
    );
    if (!orders.length) return { status: 404, data: { success: false, message: "Order not found." } };
    if (orders[0].fulfillment_type !== "pickup" || orders[0].status !== "Preparing") {
        return { status: 409, data: { success: false, message: "Only a pickup order being prepared can be marked ready." } };
    }
    return { status: 200, data: { success: true, message: "This order is already ready for pickup." } };
}

function getPayMongoConfig() {
    const secretKey = process.env.PAYMONGO_SECRET_KEY;
    const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;

    // Hosted Checkout is created server-side and requires a secret key, never pk_*.
    if (!/^sk_(test|live)_/.test(secretKey || "") || !webhookSecret) {
        return null;
    }

    return { secretKey, webhookSecret };
}

function safePublicBaseUrl(req) {
    if (process.env.APP_BASE_URL) {
        return process.env.APP_BASE_URL.replace(/\/+$/, "");
    }

    const host = req.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
        throw new Error("APP_BASE_URL must be configured for this deployment.");
    }

    return `http://${host}`;
}

async function createPayMongoCheckout(order, req) {
    const config = getPayMongoConfig();
    if (!config) {
        return {
            status: 503,
            data: {
                success: false,
                message: "GCash checkout is not configured. Add a PayMongo secret key starting with sk_test_ (or sk_live_) and the webhook signing secret to backend/.env. A pk_test_ public key cannot start a checkout."
            }
        };
    }

    const baseUrl = safePublicBaseUrl(req);
    const lineItems = order.items.map(item => ({
        name: item.name,
        amount: Math.round(item.price * 100),
        currency: "PHP",
        quantity: item.quantity
    }));

    if (order.deliveryFee > 0) {
        lineItems.push({
            name: "Delivery Fee",
            amount: Math.round(order.deliveryFee * 100),
            currency: "PHP",
            quantity: 1
        });
    }

    const checkoutResponse = await fetch(
        "https://api.paymongo.com/v2/checkout_sessions",
        {
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                data: {
                    attributes: {
                        line_items: lineItems,
                        payment_method_types: ["gcash"],
                        success_url: `${baseUrl}/Customer/payment-result.html?status=processing&reference=${encodeURIComponent(order.orderNumber)}`,
                        cancel_url: `${baseUrl}/Customer/payment-result.html?status=cancelled&reference=${encodeURIComponent(order.orderNumber)}`,
                        reference_number: order.orderNumber,
                        metadata: {
                            order_id: String(order.id),
                            order_number: order.orderNumber
                        }
                    }
                }
            })
        }
    );

    const checkoutResult = await checkoutResponse.json();
    if (!checkoutResponse.ok) {
        const message = checkoutResult.errors
            ?.map(error => error.detail || error.code)
            .filter(Boolean)
            .join(" ") || "PayMongo could not create a checkout session.";
        throw new Error(message);
    }

    const checkoutSession = checkoutResult.data;
    const checkoutUrl = checkoutSession?.attributes?.checkout_url;
    const checkoutSessionId = checkoutSession?.id;

    if (!checkoutUrl || !checkoutSessionId) {
        throw new Error("PayMongo returned an incomplete checkout session.");
    }

    await db.execute(
        `UPDATE customer_orders
         SET payment_status = 'Pending',
             paymongo_checkout_session_id = ?
         WHERE id = ? AND payment_status != 'Paid'`,
        [checkoutSessionId, order.id]
    );

    return {
        status: 201,
        data: {
            success: true,
            checkoutUrl,
            order: {
                id: order.id,
                orderNumber: order.orderNumber,
                total: order.total,
                paymentStatus: "Pending"
            }
        }
    };
}

function verifyPayMongoWebhook(req, rawBody, webhookSecret, livemode) {
    const signatureHeader = req.headers["paymongo-signature"];
    if (typeof signatureHeader !== "string") {
        return false;
    }

    const parts = new Map(
        signatureHeader.split(",").map(part => {
            const separator = part.indexOf("=");
            return separator < 0
                ? [part.trim(), ""]
                : [
                    part.slice(0, separator).trim(),
                    part.slice(separator + 1).trim()
                ];
        })
    );
    const timestamp = parts.get("t");
    const suppliedSignature = parts.get(livemode ? "li" : "te");
    if (!timestamp || !/^\d+$/.test(timestamp)) {
        return false;
    }
    if (!suppliedSignature || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
        return false;
    }

    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(`${timestamp}.${rawBody.toString("utf8")}`)
        .digest();
    const receivedSignature = Buffer.from(suppliedSignature, "hex");

    return receivedSignature.length === expectedSignature.length &&
        crypto.timingSafeEqual(receivedSignature, expectedSignature);
}

async function handlePayMongoWebhook(req, res) {
    const config = getPayMongoConfig();
    if (!config) {
        return sendJSON(res, 503, {
            success: false,
            message: "PayMongo webhook is not configured."
        });
    }

    const rawBody = await readRawBody(req);
    let payload;
    try {
        payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
        return sendJSON(res, 400, {
            success: false,
            message: "Invalid PayMongo webhook JSON."
        });
    }

    const webhookEvent = payload.data;
    const eventAttributes = webhookEvent?.attributes || {};
    const eventType = webhookEvent?.type || eventAttributes.type;
    const livemode =
        webhookEvent?.livemode === true || eventAttributes.livemode === true;
    if (!verifyPayMongoWebhook(req, rawBody, config.webhookSecret, livemode)) {
        return sendJSON(res, 401, {
            success: false,
            message: "Invalid PayMongo webhook signature."
        });
    }

    if (eventType !== "checkout_session.payment.paid") {
        return sendJSON(res, 200, { success: true, received: true });
    }

    const checkoutSession = webhookEvent?.data || eventAttributes.data;
    const attributes = checkoutSession?.attributes;
    const orderNumber = String(attributes?.reference_number || "");
    const paidPayment = attributes?.payments?.find(
        payment => payment.attributes?.status === "paid"
    );
    const paymentAttributes = paidPayment?.attributes;

    if (
        !checkoutSession?.id ||
        !orderNumber ||
        !paymentAttributes ||
        String(paymentAttributes.currency).toUpperCase() !== "PHP" ||
        !Number.isSafeInteger(Number(paymentAttributes.amount)) ||
        Number(paymentAttributes.amount) <= 0
    ) {
        return sendJSON(res, 400, {
            success: false,
            message: "PayMongo webhook is missing required payment details."
        });
    }

    const [result] = await db.execute(
        `UPDATE customer_orders
         SET payment_status = 'Paid',
             payment_reference = ?,
             payment_paid_at = CURRENT_TIMESTAMP
         WHERE order_number = ?
           AND paymongo_checkout_session_id = ?
           AND payment_method = 'GCash'
           AND total = ?`,
        [
            paidPayment.id || checkoutSession.id,
            orderNumber,
            checkoutSession.id,
            Number(paymentAttributes.amount) / 100
        ]
    );

    if (result.affectedRows > 0) {
        await db.execute(
            `UPDATE payment_records p
             INNER JOIN customer_orders co ON co.id = p.order_id
             SET p.status = 'Paid', p.reference = ?, p.paid_at = CURRENT_TIMESTAMP
             WHERE co.order_number = ?`,
            [paidPayment.id || checkoutSession.id, orderNumber]
        );
    }

    if (result.affectedRows === 0) {
        const [existingOrders] = await db.execute(
            `SELECT payment_status
             FROM customer_orders
             WHERE order_number = ?
               AND paymongo_checkout_session_id = ?
               AND total = ?`,
            [
                orderNumber,
                checkoutSession.id,
                Number(paymentAttributes.amount) / 100
            ]
        );

        if (existingOrders[0]?.payment_status !== "Paid") {
            console.error(
                `PayMongo payment could not be matched to order ${orderNumber}.`
            );
            return sendJSON(res, 404, {
                success: false,
                message: "No matching order was found for this payment."
            });
        }
    }

    return sendJSON(res, 200, { success: true, received: true });
}

async function createOrder(body, { walkIn = false, receivedByEmail = null } = {}) {
    const customerName = cleanText(body.customerName, 150) || (walkIn ? "Walk-in Customer" : "");
    const customerEmail = cleanText(body.customerEmail, 190) || (walkIn ? `walkin+${Date.now()}@walkin.invalid` : "");
    const customerPhone = cleanText(body.customerPhone, 30) || (walkIn ? "Counter order" : "");
    const fulfillmentType = walkIn ? "dine_in" : (cleanText(body.fulfillmentType, 20).toLowerCase() || "delivery");
    const pickupTime = typeof body.pickupTime === "string" ? body.pickupTime.trim() : "";
    const deliveryAddress = cleanText(body.deliveryAddress, 1000);
    const paymentMethod = walkIn ? (cleanText(body.paymentMethod, 30) === "GCash" ? "GCash" : "Cash") : (cleanText(body.paymentMethod, 50) || "Cash on Delivery");
    const proofReference = cleanText(body.proofReference, 100) || null;
    const proofImageData = typeof body.proofImageData === "string" ? body.proofImageData : null;
    if (walkIn && proofImageData && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(proofImageData) || proofImageData.length > 900000)) {
        return { status: 400, data: { success: false, message: "Receipt image must be PNG, JPEG, or WebP and under 650 KB." } };
    }
    if (walkIn && paymentMethod === "GCash" && !proofReference && !proofImageData) {
        return { status: 400, data: { success: false, message: "Add the GCash reference number or transfer receipt before submitting." } };
    }

    if (!customerName || (!walkIn && (!customerEmail || !customerPhone))) {
        return {
            status: 400,
            data: {
                success: false,
                message: "Please provide your name, email, and phone number."
            }
        };
    }

    if (!(walkIn ? fulfillmentType === "dine_in" : ["delivery", "pickup"].includes(fulfillmentType))) {
        return {
            status: 400,
            data: { success: false, message: "Choose delivery or pickup for your order." }
        };
    }
    if (!walkIn && fulfillmentType === "delivery" && !deliveryAddress) {
        return {
            status: 400,
            data: { success: false, message: "Please provide your delivery address." }
        };
    }
    if (fulfillmentType === "pickup" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) {
        return {
            status: 400,
            data: { success: false, message: "Choose a valid pickup time." }
        };
    }

    if (!walkIn && !validEmail(customerEmail)) {
        return {
            status: 400,
            data: {
                success: false,
                message: "Please enter a valid email address."
            }
        };
    }

    if (!Array.isArray(body.items) || body.items.length === 0) {
        return {
            status: 400,
            data: {
                success: false,
                message: "Your cart is empty."
            }
        };
    }

    if (body.items.length > 100) {
        return {
            status: 400,
            data: {
                success: false,
                message: "Too many different items in one order."
            }
        };
    }

    const quantities = new Map();

    for (const item of body.items) {
        const productId = Number(item.productId);
        const quantity = Number(item.quantity);

        if (
            !Number.isSafeInteger(productId) ||
            productId < 1 ||
            !Number.isSafeInteger(quantity) ||
            quantity < 1 ||
            quantity > 100
        ) {
            return {
                status: 400,
                data: {
                    success: false,
                    message: "One or more cart items are invalid."
                }
            };
        }

        const existingItem = quantities.get(productId);
        const newQuantity = (existingItem?.quantity || 0) + quantity;

        if (newQuantity > 100) {
            return {
                status: 400,
                data: {
                    success: false,
                    message: "The quantity for a product cannot exceed 100."
                }
            };
        }

        quantities.set(productId, {
            quantity: newQuantity,
            size: cleanText(item.size, 80) || "Regular"
        });
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const productIds = [...quantities.keys()];
        const placeholders = productIds.map(() => "?").join(",");

        const [products] = await connection.execute(
            `SELECT id, name, price
             FROM products
             WHERE is_available = TRUE
               AND id IN (${placeholders})
             FOR UPDATE`,
            productIds
        );

        if (products.length !== productIds.length) {
            await connection.rollback();

            return {
                status: 400,
                data: {
                    success: false,
                    message: "A product in your cart is unavailable. Refresh the menu and try again."
                }
            };
        }

        const orderItems = products.map(product => {
            const cartItem = quantities.get(product.id);
            const quantity = cartItem.quantity;
            const price = Number(product.price);

            return {
                productId: product.id,
                name: product.name,
                price,
                quantity,
                size: cartItem.size,
                lineTotal: Math.round(price * quantity * 100) / 100
            };
        });

        const subtotal = Math.round(
            orderItems.reduce((sum, item) => sum + item.lineTotal, 0) * 100
        ) / 100;

        const deliveryFee = fulfillmentType !== "delivery" || subtotal >= 800 ? 0 : 40;
        const total = Math.round((subtotal + deliveryFee) * 100) / 100;
        const savedAddress = fulfillmentType === "dine_in"
            ? "Dine-in · Jolie's Pizza, Zone 3, San Isidro St, San Roque, Northern Samar"
            : fulfillmentType === "pickup"
            ? "Customer pickup at Jolie's Pizza, Zone 3, San Isidro St, San Roque, Northern Samar"
            : deliveryAddress;

        const orderNumber =
            "JPH-" +
            Date.now().toString().slice(-8) +
            crypto.randomBytes(2).toString("hex").toUpperCase();

        const [orderResult] = await connection.execute(
            `INSERT INTO customer_orders
                (
                    order_number,
                    customer_name,
                    customer_email,
                    customer_phone,
                    delivery_address,
                    fulfillment_type,
                    pickup_time,
                    subtotal,
                    delivery_fee,
                    total,
                    payment_method,
                    payment_status,
                    payment_reference
                )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orderNumber,
                customerName,
                customerEmail,
                customerPhone,
                savedAddress,
                fulfillmentType,
                fulfillmentType === "pickup" ? pickupTime : null,
                subtotal,
                deliveryFee,
                total,
                paymentMethod,
                walkIn ? (paymentMethod === "Cash" ? "Paid" : "Pending") : "Unpaid",
                walkIn ? proofReference : null
            ]
        );

        const initialPaymentStatus = walkIn
            ? (paymentMethod === "Cash" ? "Paid" : "Pending")
            : "Pending";
        await connection.execute(
            `INSERT INTO payment_records
                (order_id, payment_method, amount, status, reference, received_by_email,
                 proof_reference, proof_image_data, is_walk_in, paid_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE order_id = VALUES(order_id)`,
            [orderResult.insertId, paymentMethod, total, initialPaymentStatus,
                walkIn ? proofReference : null, walkIn ? receivedByEmail : null,
                walkIn ? proofReference : null, walkIn ? proofImageData : null, walkIn,
                walkIn && paymentMethod === "Cash" ? new Date() : null]
        );

        if (fulfillmentType === "delivery") {
            await connection.execute(
                `INSERT INTO delivery_status_history (order_id, status, changed_by_email, note)
                 VALUES (?, 'Pending', ?, 'Order placed.')`,
                [orderResult.insertId, customerEmail]
            );
        }

        for (const item of orderItems) {
            await connection.execute(
                `INSERT INTO order_items
                    (
                        order_id,
                        product_id,
                        product_name,
                        product_price,
                        quantity,
                        line_total,
                        selected_size
                    )
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    orderResult.insertId,
                    item.productId,
                    item.name,
                    item.price,
                    item.quantity,
                    item.lineTotal,
                    item.size
                ]
            );
        }

        await connection.commit();

        return {
            status: 201,
            data: {
                success: true,
                message: "Order saved successfully.",
                order: {
                    id: orderResult.insertId,
                    orderNumber,
                    subtotal,
                    deliveryFee,
                    total,
                    fulfillmentType,
                    pickupTime: fulfillmentType === "pickup" ? pickupTime : null,
                    deliveryAddress: savedAddress,
                    status: "Pending",
                    items: orderItems
                }
            }
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/* =========================================================
   STATIC FILE SERVER
========================================================= */

const PROJECT_ROOT = path.resolve(__dirname, "..");

const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8"
};

function serveFile(req, res) {
    let requestPath;

    try {
        requestPath = decodeURIComponent(
            new URL(req.url, "http://localhost:3000").pathname
        );
    } catch {
        res.writeHead(400);
        return res.end("400 - Invalid URL");
    }

    if (requestPath === "/") {
        requestPath = "/signup.html";
    }

    const filePath = path.resolve(PROJECT_ROOT, "." + requestPath);

    if (
        filePath !== PROJECT_ROOT &&
        !filePath.startsWith(PROJECT_ROOT + path.sep)
    ) {
        res.writeHead(403);
        return res.end("403 - Forbidden");
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            });

            return res.end("404 - File Not Found");
        }

        const extension = path.extname(filePath).toLowerCase();

        res.writeHead(200, {
            "Content-Type": mimeTypes[extension] || "application/octet-stream",
            "X-Content-Type-Options": "nosniff"
        });

        if (req.method === "HEAD") {
            return res.end();
        }

        return res.end(data);
    });
}

/* =========================================================
   SERVER AND ROUTES
========================================================= */

const server = http.createServer(async (req, res) => {
    setCors(req, res);

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        if (req.method === "GET" && url.pathname === "/api/public/site-config") {
            const settings = await getAdminSettings();
            const { siteName, email, contact, address, hours, mapEmbedUrl } = settings.general;
            return sendJSON(res, 200, { success: true, business: { siteName, email, contact, address, hours, mapEmbedUrl }, design: settings.design });
        }

        const paymentListPath = url.pathname === "/api/admin/payments" || url.pathname === "/api/staff/payments";
        const paymentDetailMatch = url.pathname.match(/^\/api\/(admin|staff)\/payments\/(PAY-\d+)$/i);
        if (url.pathname === "/api/staff/reports/submissions" && req.method === "POST") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) return sendJSON(res, session ? 403 : 401, { success: false, message: "Sign in with a staff account to submit a report." });
            const body = await readJSON(req);
            const period = ["today", "week", "month"].includes(body.period) ? body.period : "week";
            const note = cleanText(body.note, 1000);
            const report = await getStaffReportData(period);
            const [result] = await db.execute(`INSERT INTO staff_business_reports (submitted_by_email, period, report_json, staff_note) VALUES (?, ?, ?, ?)`, [session.email, period, JSON.stringify(report), note || null]);
            return sendJSON(res, 201, { success: true, id: result.insertId, message: "Your business report was sent to the admin." });
        }
        const reviewReportMatch = url.pathname.match(/^\/api\/admin\/reports\/submissions\/(\d+)\/review$/);
        if (url.pathname === "/api/admin/reports/submissions" && req.method === "GET" || reviewReportMatch && req.method === "POST") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") return sendJSON(res, session ? 403 : 401, { success: false, message: "Administrator login required." });
            if (reviewReportMatch) {
                const [result] = await db.execute(`UPDATE staff_business_reports SET status='reviewed', reviewed_by_email=?, reviewed_at=NOW() WHERE id=?`, [session.email, Number(reviewReportMatch[1])]);
                if (!result.affectedRows) return sendJSON(res, 404, { success: false, message: "Staff report not found." });
                return sendJSON(res, 200, { success: true, message: "Report marked as reviewed." });
            }
            return sendJSON(res, 200, { success: true, reports: await listStaffBusinessReports() });
        }
        if (url.pathname.startsWith("/api/admin/") && ["/api/admin/settings", "/api/admin/dashboard", "/api/admin/reports"].includes(url.pathname)) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") return sendJSON(res, session ? 403 : 401, { success: false, message: "Administrator login required." });
            if (req.method === "GET" && url.pathname === "/api/admin/settings") return sendJSON(res, 200, { success: true, settings: await getAdminSettings() });
            if (req.method === "PUT" && url.pathname === "/api/admin/settings") {
                const settings = await saveAdminSettings(session, await readJSON(req));
                return sendJSON(res, 200, { success: true, settings });
            }
            if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
                const period = ["today", "week", "month"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "week";
                return sendJSON(res, 200, { success: true, ...(await getAdminDashboardData(period)) });
            }
            if (req.method === "GET" && url.pathname === "/api/admin/reports") return sendJSON(res, 200, { success: true, ...(await getAdminReportsData(url.searchParams.get("from"), url.searchParams.get("to"))) });
        }
        if (req.method === "GET" && (url.pathname === "/api/staff/dashboard" || url.pathname === "/api/staff/reports")) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff login is required to view this page." });
            }
            if (url.pathname === "/api/staff/dashboard") {
                return sendJSON(res, 200, { success: true, ...(await getStaffDashboardData()) });
            }
            const requestedPeriod = url.searchParams.get("period");
            const period = ["today", "week", "month"].includes(requestedPeriod) ? requestedPeriod : "week";
            return sendJSON(res, 200, { success: true, ...(await getStaffReportData(period)) });
        }
        if (paymentListPath || paymentDetailMatch) {
            const session = await getApiSession(req);
            const isAdminPath = url.pathname.startsWith("/api/admin/");
            const permitted = isAdminPath ? session?.role === "admin" : ["staff", "admin"].includes(session?.role);
            if (!session || !permitted) return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff or admin login is required to view payment history." });
            if (paymentListPath && req.method === "GET") {
                const result = await getPaymentHistory(url);
                return sendJSON(res, 200, { success: true, ...result });
            }
            if (paymentDetailMatch && req.method === "GET") {
                const payment = await getPaymentHistory(url, paymentDetailMatch[2]);
                return payment
                    ? sendJSON(res, 200, { success: true, payment })
                    : sendJSON(res, 404, { success: false, message: "Payment not found." });
            }
        }

        const paymentActionMatch = url.pathname.match(/^\/api\/staff\/payments\/(PAY-\d+)\/action$/i);
        if (req.method === "POST" && paymentActionMatch) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff or admin login is required to update payments." });
            const body = await readJSON(req);
            const result = await updatePaymentAction(session, paymentActionMatch[1], cleanText(body.action, 20).toLowerCase(), body.note);
            return sendJSON(res, result.status, result.data);
        }

        if (req.method === "GET" && url.pathname === "/api/config/gcash") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff login is required." });
            return sendJSON(res, 200, { success: true, accountName: process.env.GCASH_ACCOUNT_NAME || "", accountNumber: process.env.GCASH_ACCOUNT_NUMBER || "", qrImageUrl: process.env.GCASH_QR_IMAGE_URL || "" });
        }

        if (req.method === "POST" && url.pathname === "/api/staff/walk-in/orders") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff or admin login is required to create a walk-in order." });
            const body = await readJSON(req);
            const result = await createOrder(body, { walkIn: true, receivedByEmail: session.email });
            return sendJSON(res, result.status, result.data);
        }

        if (req.method === "GET" && url.pathname === "/api/staff/walk-in/menu") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff login is required." });
            return sendJSON(res, 200, { success: true, products: await getProducts(url) });
        }

        if (url.pathname === "/api/inventory" && req.method === "GET") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to view inventory."
                });
            }
            return sendJSON(res, 200, { success: true, items: await getInventoryItems() });
        }

        if (url.pathname === "/api/inventory/requests" && req.method === "GET") {
            const session = await getApiSession(req);
            if (!session || session.role !== "staff") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff login is required to view stock requests."
                });
            }
            return sendJSON(res, 200, {
                success: true,
                requests: await getInventoryRequests({ email: session.email })
            });
        }

        if (url.pathname === "/api/inventory/requests" && req.method === "POST") {
            const session = await getApiSession(req);
            if (!session || session.role !== "staff") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff login is required to submit stock requests."
                });
            }
            const result = await createInventoryStockRequest(session, await readJSON(req));
            return sendJSON(res, result.status, result.data);
        }

        if (url.pathname === "/api/admin/inventory/requests" && req.method === "GET") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to review stock requests."
                });
            }
            return sendJSON(res, 200, {
                success: true,
                requests: await getInventoryRequests({ pendingOnly: url.searchParams.get("status") !== "all" })
            });
        }

        const inventoryFulfillMatch = url.pathname.match(/^\/api\/admin\/inventory\/requests\/(\d+)\/fulfill$/);
        if (req.method === "POST" && inventoryFulfillMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to fulfill stock requests."
                });
            }
            const body = await readJSON(req);
            const result = await fulfillInventoryRequest(
                session,
                Number(inventoryFulfillMatch[1]),
                body.quantity,
                body.note
            );
            return sendJSON(res, result.status, result.data);
        }

        const inventoryRejectMatch = url.pathname.match(/^\/api\/admin\/inventory\/requests\/(\d+)\/reject$/);
        if (req.method === "POST" && inventoryRejectMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to update stock requests."
                });
            }
            const body = await readJSON(req);
            const [result] = await db.execute(
                `UPDATE inventory_stock_requests
                 SET status = 'rejected', responded_by_email = ?, response_note = ?
                 WHERE id = ? AND status = 'pending'`,
                [session.email, cleanText(body.note, 500) || null, Number(inventoryRejectMatch[1])]
            );
            return sendJSON(res, result.affectedRows ? 200 : 404, {
                success: Boolean(result.affectedRows),
                message: result.affectedRows ? "Stock request rejected." : "Pending stock request not found."
            });
        }

        if (url.pathname === "/api/admin/inventory/items" && req.method === "POST") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to create inventory items."
                });
            }
            const body = await readJSON(req);
            const name = cleanText(body.name, 150);
            const category = cleanText(body.category, 80) || "Ingredients";
            const unit = cleanText(body.unit, 30);
            const threshold = Number(body.threshold ?? 1);
            if (!name || !unit || !Number.isFinite(threshold) || threshold < 0) {
                return sendJSON(res, 400, { success: false, message: "Enter an ingredient name, unit, and valid low-stock threshold." });
            }
            try {
                const [result] = await db.execute(
                    `INSERT INTO inventory_items (name, category, unit, low_stock_threshold)
                     VALUES (?, ?, ?, ?)`,
                    [name, category, unit, threshold]
                );
                return sendJSON(res, 201, { success: true, id: result.insertId, message: "Ingredient added to inventory." });
            } catch (error) {
                if (error.code === "ER_DUP_ENTRY") {
                    return sendJSON(res, 409, { success: false, message: "An inventory item with that name already exists." });
                }
                throw error;
            }
        }

        if (url.pathname === "/api/admin/inventory/movements" && req.method === "POST") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to record stock movements."
                });
            }
            const result = await recordInventoryMovement(session, await readJSON(req));
            return sendJSON(res, result.status, result.data);
        }

        if (req.method === "POST" && url.pathname === "/api/register") {
            return registerUser(req, res);
        }

        if (req.method === "POST" && url.pathname === "/api/login") {
            return loginUser(req, res);
        }

        if (req.method === "GET" && url.pathname === "/api/auth/google/nonce") {
            return sendJSON(res, 200, {
                success: true,
                nonce: issueGoogleNonce()
            });
        }

        if (req.method === "GET" && url.pathname === "/api/config/google-auth") {
            return sendJSON(res, 200, {
                success: true,
                enabled: Boolean(String(process.env.GOOGLE_CLIENT_ID || "").trim()),
                clientId: String(process.env.GOOGLE_CLIENT_ID || "").trim() || null
            });
        }

        if (req.method === "POST" && url.pathname === "/api/auth/google") {
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
            }

            const body = await readJSON(req);
            const nonceExpiry = pendingGoogleNonces.get(String(body.nonce || ""));
            if (!nonceExpiry || nonceExpiry <= Date.now()) {
                pendingGoogleNonces.delete(String(body.nonce || ""));
                return sendJSON(res, 401, {
                    success: false,
                    message: "Google sign-in expired. Please try again."
                });
            }
            pendingGoogleNonces.delete(String(body.nonce));
            const googleUser = await verifyGoogleIdToken(body.credential, body.nonce);
            const [users] = await db.execute(
                `SELECT id, full_name, email, role, is_active
                 FROM users WHERE email = ? LIMIT 1`,
                [googleUser.email]
            );

            let user = users[0];
            if (user && String(user.role).toLowerCase() !== "customer") {
                return sendJSON(res, 403, {
                    success: false,
                    message: "Google sign-in is available for customer accounts only."
                });
            }
            if (user && Number(user.is_active) !== 1) {
                return sendJSON(res, 403, {
                    success: false,
                    message: "This account is inactive. Please contact the restaurant."
                });
            }
            if (!user) {
                const randomPassword = crypto.randomBytes(48).toString("hex");
                const passwordHash = await bcrypt.hash(randomPassword, 12);
                const [result] = await db.execute(
                    `INSERT INTO users (full_name, email, phone, password_hash, role)
                     VALUES (?, ?, '', ?, 'customer')`,
                    [googleUser.fullName, googleUser.email, passwordHash]
                );
                user = {
                    id: result.insertId,
                    full_name: googleUser.fullName,
                    email: googleUser.email,
                    role: "customer"
                };
            }

            const remember = body.remember === true;
            const sessionToken = await createApiSession(user.email, "customer", remember);
            return sendJSON(res, 200, {
                success: true,
                message: "Google sign-in successful.",
                sessionToken,
                user: {
                    id: user.id,
                    fullName: user.full_name || googleUser.fullName,
                    email: user.email,
                    role: "customer"
                }
            });
        }

        if (req.method === "POST" && url.pathname === "/api/logout") {
            const session = await getApiSession(req);
            if (session) {
                await recordStaffTimeOut(session);
                await deleteApiSession(session);
            }

            return sendJSON(res, 200, {
                success: true,
                message: "Logged out successfully."
            });
        }

        if (req.method === "POST" && url.pathname === "/api/contact") {
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
            }

            const body = await readJSON(req);
            const fullName = cleanText(body.fullName, 150);
            const email = cleanText(body.email, 254).toLowerCase();
            const phone = cleanText(body.phone, 30);
            const inquiryType = cleanText(body.inquiryType, 80);
            const message = typeof body.message === "string" ? body.message.trim() : "";
            const allowedInquiryTypes = new Set([
                "order", "delivery", "payment", "product", "feedback", "other"
            ]);

            if (!fullName || !email || !inquiryType || !message) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Name, email, inquiry type, and message are required."
                });
            }
            if (!allowedInquiryTypes.has(inquiryType)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Please select a valid inquiry type."
                });
            }
            if (!validEmail(email)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Please provide a valid email address."
                });
            }
            if (message.length > 10000) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Your message must be 10,000 characters or fewer."
                });
            }

            const [result] = await db.execute(
                `INSERT INTO contact_messages
                    (full_name, email, phone, inquiry_type, message, status)
                 VALUES (?, ?, ?, ?, ?, 'new')`,
                [fullName, email, phone || null, inquiryType, message]
            );

            return sendJSON(res, 201, {
                success: true,
                message: "Your message was sent successfully.",
                id: result.insertId
            });
        }

        if (req.method === "GET" && url.pathname === "/api/health") {
            await db.query("SELECT 1");

            return sendJSON(res, 200, {
                success: true,
                message: "Jolie's Pizza API and MySQL are connected."
            });
        }

        if (req.method === "GET" && url.pathname === "/api/categories") {
            const categories = await getCategories();

            return sendJSON(res, 200, {
                success: true,
                categories
            });
        }

        if (req.method === "GET" && url.pathname === "/api/products") {
            const products = await getProducts(url);

            return sendJSON(res, 200, {
                success: true,
                count: products.length,
                products
            });
        }

        if (url.pathname === "/api/admin/menu" && req.method === "GET") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to manage the menu." });
            }
            return sendJSON(res, 200, { success: true, ...(await getAdminMenuData()) });
        }

        if (url.pathname === "/api/admin/menu-items" && ["POST"].includes(req.method)) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to edit menu items." });
            }
            const body = await readJSON(req);
            const name = cleanText(body.name, 150);
            const description = cleanText(body.description, 2000);
            const imageUrl = cleanText(body.imageUrl, 1000);
            const categoryId = Number(body.categoryId);
            const price = Number(body.price);
            if (!name || !description || !Number.isInteger(categoryId) || categoryId < 1 || !Number.isFinite(price) || price < 0 || typeof body.isAvailable !== "boolean" || /^[a-z][a-z0-9+.-]*:/i.test(imageUrl) && !/^https?:\/\//i.test(imageUrl)) {
                return sendJSON(res, 400, { success: false, message: "Enter the item name, description, category, price, and availability." });
            }
            const [category] = await db.execute("SELECT id FROM categories WHERE id = ? LIMIT 1", [categoryId]);
            if (!category.length) return sendJSON(res, 400, { success: false, message: "Choose an existing menu category." });
            const [result] = await db.execute(
                `INSERT INTO products (category_id, name, description, price, image_url, tags, is_available)
                 VALUES (?, ?, ?, ?, ?, '', ?)`,
                [categoryId, name, description, price, imageUrl || "", body.isAvailable]
            );
            return sendJSON(res, 201, { success: true, id: result.insertId, message: "Menu item added." });
        }

        const adminMenuItemMatch = url.pathname.match(/^\/api\/admin\/menu-items\/(\d+)$/);
        if (adminMenuItemMatch && ["PATCH", "DELETE"].includes(req.method)) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to edit menu items." });
            }
            const id = Number(adminMenuItemMatch[1]);
            if (req.method === "DELETE") {
                const [result] = await db.execute("UPDATE products SET is_available = FALSE WHERE id = ?", [id]);
                if (!result.affectedRows) return sendJSON(res, 404, { success: false, message: "Menu item not found." });
                return sendJSON(res, 200, { success: true, message: "Menu item marked inactive. Previous order records are preserved." });
            }
            const body = await readJSON(req);
            const name = cleanText(body.name, 150);
            const description = cleanText(body.description, 2000);
            const imageUrl = cleanText(body.imageUrl, 1000);
            const categoryId = Number(body.categoryId);
            const price = Number(body.price);
            if (!name || !description || !Number.isInteger(categoryId) || categoryId < 1 || !Number.isFinite(price) || price < 0 || typeof body.isAvailable !== "boolean" || /^[a-z][a-z0-9+.-]*:/i.test(imageUrl) && !/^https?:\/\//i.test(imageUrl)) {
                return sendJSON(res, 400, { success: false, message: "Enter the item name, description, category, price, and availability." });
            }
            const [category] = await db.execute("SELECT id FROM categories WHERE id = ? LIMIT 1", [categoryId]);
            if (!category.length) return sendJSON(res, 400, { success: false, message: "Choose an existing menu category." });
            const [result] = await db.execute(
                `UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, image_url = ?, is_available = ? WHERE id = ?`,
                [categoryId, name, description, price, imageUrl || "", body.isAvailable, id]
            );
            if (!result.affectedRows) {
                const [existing] = await db.execute("SELECT id FROM products WHERE id = ? LIMIT 1", [id]);
                if (!existing.length) return sendJSON(res, 404, { success: false, message: "Menu item not found." });
            }
            return sendJSON(res, 200, { success: true, message: "Menu item updated." });
        }

        if (url.pathname === "/api/admin/categories" && ["POST"].includes(req.method)) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to manage categories." });
            }
            const body = await readJSON(req);
            const name = cleanText(body.name, 150);
            const description = cleanText(body.description, 2000);
            const slug = menuSlug(name);
            if (!name || !slug || typeof body.isActive !== "boolean") {
                return sendJSON(res, 400, { success: false, message: "Enter a category name and choose its status." });
            }
            try {
                const [result] = await db.execute(
                    "INSERT INTO categories (name, slug, description, is_active) VALUES (?, ?, ?, ?)",
                    [name, slug, description || null, body.isActive]
                );
                return sendJSON(res, 201, { success: true, id: result.insertId, message: "Category added." });
            } catch (error) {
                if (error.code === "ER_DUP_ENTRY") return sendJSON(res, 409, { success: false, message: "A category with that name already exists." });
                throw error;
            }
        }

        const adminCategoryMatch = url.pathname.match(/^\/api\/admin\/categories\/(\d+)$/);
        if (adminCategoryMatch && ["PATCH", "DELETE"].includes(req.method)) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to manage categories." });
            }
            const id = Number(adminCategoryMatch[1]);
            if (req.method === "DELETE") {
                const [[{ itemCount }]] = await db.execute("SELECT COUNT(*) AS itemCount FROM products WHERE category_id = ?", [id]);
                if (Number(itemCount) > 0) return sendJSON(res, 409, { success: false, message: "This category still has menu items. Move or deactivate those items first." });
                const [result] = await db.execute("DELETE FROM categories WHERE id = ?", [id]);
                if (!result.affectedRows) return sendJSON(res, 404, { success: false, message: "Category not found." });
                return sendJSON(res, 200, { success: true, message: "Category deleted." });
            }
            const body = await readJSON(req);
            const name = cleanText(body.name, 150);
            const description = cleanText(body.description, 2000);
            const slug = menuSlug(name);
            if (!name || !slug || typeof body.isActive !== "boolean") {
                return sendJSON(res, 400, { success: false, message: "Enter a category name and choose its status." });
            }
            try {
                const [result] = await db.execute(
                    "UPDATE categories SET name = ?, slug = ?, description = ?, is_active = ? WHERE id = ?",
                    [name, slug, description || null, body.isActive, id]
                );
                if (!result.affectedRows) {
                    const [existing] = await db.execute("SELECT id FROM categories WHERE id = ? LIMIT 1", [id]);
                    if (!existing.length) return sendJSON(res, 404, { success: false, message: "Category not found." });
                }
                return sendJSON(res, 200, { success: true, message: "Category updated." });
            } catch (error) {
                if (error.code === "ER_DUP_ENTRY") return sendJSON(res, 409, { success: false, message: "A category with that name already exists." });
                throw error;
            }
        }

        if (req.method === "GET" && url.pathname === "/api/admin/staff") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to manage staff accounts." });
            }
            const search = cleanText(url.searchParams.get("search"), 120);
            const requestedStatus = cleanText(url.searchParams.get("status"), 20).toLowerCase();
            const conditions = ["u.role = 'staff'"];
            const params = [];
            if (search) {
                conditions.push("(u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)");
                const term = `%${search}%`;
                params.push(term, term, term);
            }
            if (["pending", "approved", "declined"].includes(requestedStatus)) {
                conditions.push("u.approval_status = ?");
                params.push(requestedStatus);
            }
            const [staff] = await db.execute(
                `SELECT u.id, u.full_name, u.email, u.phone, u.staff_position, u.staff_shift,
                        u.staff_address, u.is_active, u.approval_status, u.created_at,
                        (SELECT a.time_in FROM staff_attendance a WHERE a.user_id = u.id ORDER BY a.time_in DESC, a.id DESC LIMIT 1) AS last_time_in,
                        (SELECT a.time_out FROM staff_attendance a WHERE a.user_id = u.id ORDER BY a.time_in DESC, a.id DESC LIMIT 1) AS last_time_out
                 FROM users u WHERE ${conditions.join(" AND ")} ORDER BY (u.approval_status = 'pending') DESC, u.created_at DESC, u.id DESC`,
                params
            );
            const [counts] = await db.execute(
                `SELECT approval_status, COUNT(*) AS count FROM users WHERE role = 'staff' GROUP BY approval_status`
            );
            return sendJSON(res, 200, {
                success: true,
                staff: staff.map(person => ({
                    id: person.id,
                    fullName: person.full_name,
                    email: person.email,
                    phone: person.phone || "",
                    position: person.staff_position || "Staff",
                    shift: person.staff_shift || "Not set",
                    address: person.staff_address || "",
                    isActive: Boolean(person.is_active),
                    approvalStatus: person.approval_status,
                    createdAt: person.created_at,
                    lastTimeIn: person.last_time_in,
                    lastTimeOut: person.last_time_out
                })),
                counts: Object.fromEntries(counts.map(row => [row.approval_status, Number(row.count)]))
            });
        }

        const adminStaffAttendanceMatch = url.pathname.match(/^\/api\/admin\/staff\/(\d+)\/attendance$/);
        if (req.method === "GET" && adminStaffAttendanceMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to view staff attendance." });
            }
            const staffId = Number(adminStaffAttendanceMatch[1]);
            const [records] = await db.execute(
                `SELECT time_in AS timeIn, time_out AS timeOut FROM staff_attendance WHERE user_id = ? ORDER BY time_in DESC LIMIT 60`,
                [staffId]
            );
            return sendJSON(res, 200, { success: true, attendance: records });
        }

        const adminStaffApprovalMatch = url.pathname.match(/^\/api\/admin\/staff\/(\d+)\/approval$/);
        if (req.method === "PATCH" && adminStaffApprovalMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to approve staff accounts." });
            }
            const body = await readJSON(req);
            const decision = String(body.decision || "").toLowerCase();
            if (!["approved", "declined"].includes(decision)) {
                return sendJSON(res, 400, { success: false, message: "Choose approve or decline for this staff request." });
            }
            const [result] = await db.execute(
                `UPDATE users SET approval_status = ?, is_active = ? WHERE id = ? AND role = 'staff'`,
                [decision, decision === "approved", Number(adminStaffApprovalMatch[1])]
            );
            if (!result.affectedRows) {
                const [existing] = await db.execute("SELECT id FROM users WHERE id = ? AND role = 'staff' LIMIT 1", [Number(adminStaffApprovalMatch[1])]);
                if (!existing.length) return sendJSON(res, 404, { success: false, message: "Staff account not found." });
            }
            if (decision === "declined") {
                const [staff] = await db.execute("SELECT email FROM users WHERE id = ? AND role = 'staff' LIMIT 1", [Number(adminStaffApprovalMatch[1])]);
                if (staff[0]) await db.execute("DELETE FROM api_sessions WHERE email = ?", [staff[0].email]);
            }
            return sendJSON(res, 200, { success: true, message: decision === "approved" ? "Staff account approved. They can now log in." : "Staff account request declined." });
        }

        const adminStaffMatch = url.pathname.match(/^\/api\/admin\/staff\/(\d+)$/);
        if (adminStaffMatch && ["PATCH", "DELETE"].includes(req.method)) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "An admin login is required to manage staff accounts." });
            }
            const staffId = Number(adminStaffMatch[1]);
            if (req.method === "DELETE") {
                const [staff] = await db.execute("SELECT email FROM users WHERE id = ? AND role = 'staff' LIMIT 1", [staffId]);
                if (!staff.length) return sendJSON(res, 404, { success: false, message: "Staff account not found." });
                const connection = await db.getConnection();
                try {
                    await connection.beginTransaction();
                    await connection.execute("DELETE FROM api_sessions WHERE email = ?", [staff[0].email]);
                    await connection.execute("DELETE FROM staff_attendance WHERE user_id = ?", [staffId]);
                    await connection.execute("DELETE FROM users WHERE id = ? AND role = 'staff'", [staffId]);
                    await connection.commit();
                } catch (error) {
                    await connection.rollback();
                    throw error;
                } finally {
                    connection.release();
                }
                return sendJSON(res, 200, { success: true, message: "Staff account deleted." });
            }
            const body = await readJSON(req);
            const fullName = cleanText(body.fullName, 150);
            const phone = cleanText(body.phone, 30);
            const position = cleanText(body.position, 80);
            const shift = cleanText(body.shift, 100);
            const address = cleanText(body.address, 500);
            if (!fullName || !position) return sendJSON(res, 400, { success: false, message: "Enter the staff name and position." });
            const [result] = await db.execute(
                `UPDATE users SET full_name = ?, phone = ?, staff_position = ?, staff_shift = ?, staff_address = ?
                 WHERE id = ? AND role = 'staff'`,
                [fullName, phone, position, shift || null, address || null, staffId]
            );
            if (!result.affectedRows) {
                const [existing] = await db.execute("SELECT id FROM users WHERE id = ? AND role = 'staff' LIMIT 1", [staffId]);
                if (!existing.length) return sendJSON(res, 404, { success: false, message: "Staff account not found." });
            }
            return sendJSON(res, 200, { success: true, message: "Staff details updated." });
        }

        if (req.method === "GET" && url.pathname === "/api/config/google-maps") {
            if (!process.env.GOOGLE_MAPS_API_KEY) {
                return sendJSON(res, 503, {
                    success: false,
                    message: "Google Maps is not configured. Set GOOGLE_MAPS_API_KEY in the backend environment."
                });
            }

            return sendJSON(res, 200, {
                success: true,
                apiKey: process.env.GOOGLE_MAPS_API_KEY
            });
        }

        if (req.method === "GET" && url.pathname === "/api/staff/products") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to manage menu availability."
                });
            }
            const products = await getStaffMenuProducts();
            return sendJSON(res, 200, { success: true, products });
        }

        const staffProductAvailabilityMatch = url.pathname.match(
            /^\/api\/staff\/products\/(\d+)\/availability$/
        );
        if (req.method === "PATCH" && staffProductAvailabilityMatch) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to manage menu availability."
                });
            }
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, { success: false, message: "Content-Type must be application/json." });
            }
            const body = await readJSON(req);
            if (typeof body?.isAvailable !== "boolean") {
                return sendJSON(res, 400, { success: false, message: "Choose whether this product is available." });
            }
            const productId = Number(staffProductAvailabilityMatch[1]);
            const [result] = await db.execute(
                "UPDATE products SET is_available = ? WHERE id = ?",
                [body.isAvailable, productId]
            );
            if (result.affectedRows === 0) {
                const [existing] = await db.execute("SELECT id FROM products WHERE id = ? LIMIT 1", [productId]);
                if (!existing.length) {
                    return sendJSON(res, 404, { success: false, message: "Menu product not found." });
                }
            }
            return sendJSON(res, 200, {
                success: true,
                isAvailable: body.isAvailable,
                message: body.isAvailable ? "Product is available on the customer menu." : "Product is marked out of stock."
            });
        }

        const adminDeliveryMatch = url.pathname.match(/^\/api\/admin\/deliveries(?:\/([^/]+))?$/);
        if (req.method === "GET" && adminDeliveryMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to view delivery history."
                });
            }
            const requestedOrder = adminDeliveryMatch[1]
                ? cleanText(decodeURIComponent(adminDeliveryMatch[1]), 30).toUpperCase()
                : "";
            const deliveries = await getAdminDeliveryHistory(requestedOrder);
            if (requestedOrder && !deliveries.length) {
                return sendJSON(res, 404, { success: false, message: "Delivery record not found." });
            }
            if (requestedOrder) {
                const [history] = await db.execute(
                    `SELECT status, changed_by_email AS changedBy, note, created_at AS createdAt
                     FROM delivery_status_history WHERE order_id = ? ORDER BY created_at ASC, id ASC`,
                    [deliveries[0].id]
                );
                deliveries[0].history = history;
            }
            return sendJSON(res, 200, requestedOrder
                ? { success: true, delivery: deliveries[0] }
                : { success: true, deliveries, total: deliveries.length });
        }

        if (req.method === "GET" && url.pathname === "/api/staff/deliveries") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to view active deliveries."
                });
            }

            const deliveries = await getStaffDeliveries();
            return sendJSON(res, 200, { success: true, deliveries });
        }

        if (req.method === "GET" && url.pathname === "/api/staff/orders") {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to view orders."
                });
            }

            const orders = await getStaffOrders();
            return sendJSON(res, 200, { success: true, orders });
        }

        if (req.method === "GET" && url.pathname === "/api/admin/orders") {
            const session = await getApiSession(req);
            if (!session || session.role !== "admin") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "An admin login is required to view customer order history."
                });
            }

            const allowedStatuses = new Set(["Pending", "Confirmed", "Preparing", "Out for Delivery", "Completed", "Cancelled"]);
            const rawStatus = cleanText(url.searchParams.get("status"), 40);
            const rawType = cleanText(url.searchParams.get("type"), 20).toLowerCase();
            const requestedDays = Number(url.searchParams.get("days"));
            const result = await getAdminOrderHistory({
                search: cleanText(url.searchParams.get("search"), 120),
                status: allowedStatuses.has(rawStatus) ? rawStatus : "",
                type: ["delivery", "pickup"].includes(rawType) ? rawType : "",
                dateDays: [7, 30].includes(requestedDays) ? requestedDays : 0,
                page: url.searchParams.get("page"),
                pageSize: url.searchParams.get("pageSize")
            });
            return sendJSON(res, 200, { success: true, ...result });
        }

        const staffRiderMatch = url.pathname.match(
            /^\/api\/staff\/orders\/([^/]+)\/rider$/
        );
        if (req.method === "POST" && staffRiderMatch) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to assign a rider."
                });
            }
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, { success: false, message: "Content-Type must be application/json." });
            }
            const orderNumber = cleanText(decodeURIComponent(staffRiderMatch[1]), 30).toUpperCase();
            if (!/^JPH-[A-Z0-9]+$/.test(orderNumber)) {
                return sendJSON(res, 400, { success: false, message: "Invalid order number." });
            }
            const body = await readJSON(req);
            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return sendJSON(res, 400, { success: false, message: "Rider details are invalid." });
            }
            const result = await saveDeliveryAssignment(orderNumber, session.email, body);
            return sendJSON(res, result.status, result.data);
        }

        const staffPickupReadyMatch = url.pathname.match(/^\/api\/staff\/orders\/([^/]+)\/pickup-ready$/);
        if (req.method === "POST" && staffPickupReadyMatch) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, { success: false, message: "A staff or admin login is required." });
            }
            const orderNumber = cleanText(decodeURIComponent(staffPickupReadyMatch[1]), 30).toUpperCase();
            if (!/^JPH-[A-Z0-9]+$/.test(orderNumber)) {
                return sendJSON(res, 400, { success: false, message: "Invalid order number." });
            }
            const result = await markPickupOrderReady(orderNumber);
            return sendJSON(res, result.status, result.data);
        }

        const staffStatusMatch = url.pathname.match(
            /^\/api\/staff\/orders\/([^/]+)\/status$/
        );
        if (req.method === "POST" && staffStatusMatch) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to dispatch orders."
                });
            }

            const orderNumber = cleanText(
                decodeURIComponent(staffStatusMatch[1]),
                30
            ).toUpperCase();
            if (!/^JPH-[A-Z0-9]+$/.test(orderNumber)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Invalid order number."
                });
            }
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
            }

            const body = await readJSON(req);
            if (!["Confirmed", "Preparing", "Out for Delivery", "Completed", "Cancelled"].includes(body?.status)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Invalid order status transition."
                });
            }

            const result = await advanceCustomerOrder(orderNumber, body.status, session.email);
            return sendJSON(res, result.status, result.data);
        }

        const staffLocationMatch = url.pathname.match(
            /^\/api\/staff\/orders\/([^/]+)\/location$/
        );
        if (
            staffLocationMatch &&
            (req.method === "POST" || req.method === "DELETE")
        ) {
            const session = await getApiSession(req);
            if (!session || !["staff", "admin"].includes(session.role)) {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "A staff or admin login is required to share delivery GPS."
                });
            }

            const orderNumber = cleanText(
                decodeURIComponent(staffLocationMatch[1]),
                30
            ).toUpperCase();
            if (!/^JPH-[A-Z0-9]+$/.test(orderNumber)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Invalid order number."
                });
            }

            if (req.method === "DELETE") {
                const [result] = await db.execute(
                    `DELETE dt
                     FROM delivery_tracking dt
                     INNER JOIN customer_orders co ON co.id = dt.order_id
                     WHERE co.order_number = ? AND dt.rider_email = ?`,
                    [orderNumber, session.email]
                );
                return sendJSON(res, 200, {
                    success: true,
                    message: result.affectedRows > 0
                        ? "GPS sharing stopped."
                        : "There was no active GPS share for this rider."
                });
            }

            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
            }

            const body = await readJSON(req);
            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "The GPS location data is invalid."
                });
            }
            const result = await saveDeliveryLocation(
                orderNumber,
                session.email,
                body
            );
            return sendJSON(res, result.status, result.data);
        }

        const customerTrackingMatch = url.pathname.match(
            /^\/api\/orders\/([^/]+)\/tracking$/
        );
        if (req.method === "GET" && customerTrackingMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "customer") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "Log in as the customer who placed this order to view its tracking."
                });
            }

            const orderNumber = cleanText(
                decodeURIComponent(customerTrackingMatch[1]),
                30
            ).toUpperCase();
            const tracking = await getCustomerDeliveryLocation(
                orderNumber,
                session.email
            );
            if (!tracking) {
                return sendJSON(res, 404, {
                    success: false,
                    message: "Order not found for this customer account."
                });
            }

            return sendJSON(res, 200, { success: true, tracking });
        }

        const customerCancelMatch = url.pathname.match(
            /^\/api\/orders\/([^/]+)\/cancel$/
        );
        if (req.method === "POST" && customerCancelMatch) {
            const session = await getApiSession(req);
            if (!session || session.role !== "customer") {
                return sendJSON(res, session ? 403 : 401, {
                    success: false,
                    message: "Log in as the customer who placed this order to cancel it."
                });
            }

            const orderNumber = cleanText(
                decodeURIComponent(customerCancelMatch[1]),
                30
            ).toUpperCase();
            if (!/^JPH-[A-Z0-9]+$/.test(orderNumber)) {
                return sendJSON(res, 400, {
                    success: false,
                    message: "Invalid order number."
                });
            }

            const result = await cancelCustomerOrder(orderNumber, session.email);
            return sendJSON(res, result.status, result.data);
        }

        if (req.method === "GET" && url.pathname === "/api/orders") {
            const session = await getApiSession(req);

            if (!session) {
                return sendJSON(res, 401, {
                    success: false,
                    message: "Please log in again to view your orders."
                });
            }

            const orders = await getCustomerOrders(session.email);

            return sendJSON(res, 200, {
                success: true,
                count: orders.length,
                orders
            });
        }

        if (
            req.method === "POST" &&
            url.pathname === "/api/payments/gcash/checkout"
        ) {
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
            }

            if (!getPayMongoConfig()) {
                return sendJSON(res, 503, {
                    success: false,
                    message: "GCash checkout is not configured. Add a PayMongo secret key starting with sk_test_ (or sk_live_) and the webhook signing secret to backend/.env. A pk_test_ public key cannot start a checkout."
                });
            }

            try {
                safePublicBaseUrl(req);
            } catch (error) {
                return sendJSON(res, 503, {
                    success: false,
                    message: error.message
                });
            }

            const authorizationHeader = req.headers.authorization;
            const session = authorizationHeader
                ? await getApiSession(req)
                : null;

            if (authorizationHeader && !session) {
                return sendJSON(res, 401, {
                    success: false,
                    message: "Your session has expired. Please log in again."
                });
            }

            const body = await readJSON(req);
            if (
                session &&
                cleanText(body.customerEmail, 190).toLowerCase() !== session.email
            ) {
                return sendJSON(res, 403, {
                    success: false,
                    message: "Orders from your account must use your account email address."
                });
            }

            const orderResult = await createOrder({
                ...body,
                paymentMethod: "GCash"
            });

            if (orderResult.status !== 201) {
                return sendJSON(res, orderResult.status, orderResult.data);
            }

            const order = orderResult.data.order;
            await db.execute(
                `UPDATE customer_orders
                 SET payment_status = 'Pending'
                 WHERE id = ?`,
                [order.id]
            );

            try {
                const checkoutResult = await createPayMongoCheckout(order, req);
                return sendJSON(res, checkoutResult.status, checkoutResult.data);
            } catch (error) {
                console.error("Could not create PayMongo checkout session:", error);
                await db.execute(
                    `UPDATE customer_orders
                     SET payment_status = 'Failed'
                     WHERE id = ? AND payment_status != 'Paid'`,
                    [order.id]
                );
                await db.execute(
                    `UPDATE payment_records SET status = 'Failed' WHERE order_id = ? AND status != 'Paid'`,
                    [order.id]
                );
                return sendJSON(res, 502, {
                    success: false,
                    message: "Your order was saved, but PayMongo could not start the GCash payment. Check My Orders or contact the shop before placing another order.",
                    orderNumber: order.orderNumber
                });
            }
        }

        if (
            req.method === "POST" &&
            url.pathname === "/api/webhooks/paymongo"
        ) {
            return handlePayMongoWebhook(req, res);
        }

        if (req.method === "POST" && url.pathname === "/api/orders") {
            if (!req.headers["content-type"]?.includes("application/json")) {
                return sendJSON(res, 415, {
                    success: false,
                    message: "Content-Type must be application/json."
                });
            }

            const authorizationHeader = req.headers.authorization;
            const session = authorizationHeader
                ? await getApiSession(req)
                : null;

            if (authorizationHeader && !session) {
                return sendJSON(res, 401, {
                    success: false,
                    message: "Your session has expired. Please log in again."
                });
            }

            const body = await readJSON(req);

            if (
                session &&
                cleanText(body.customerEmail, 190).toLowerCase() !== session.email
            ) {
                return sendJSON(res, 403, {
                    success: false,
                    message: "Orders from your account must use your account email address."
                });
            }

            const result = await createOrder(body);

            return sendJSON(res, result.status, result.data);
        }

        if (req.method === "GET" || req.method === "HEAD") {
            return serveFile(req, res);
        }

        return sendJSON(res, 404, {
            success: false,
            message: "API route not found."
        });
    } catch (error) {
        console.error("API error:", error);

        if (!res.headersSent) {
            sendJSON(res, 500, {
                success: false,
                message: "A server error occurred. Check the backend terminal."
            });
        }
    }
});

/* =========================================================
   START SERVER
========================================================= */

async function ensureOrderFulfillmentColumns() {
    const [columns] = await db.execute(
        `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'customer_orders'
           AND COLUMN_NAME IN ('fulfillment_type', 'pickup_time', 'pickup_status')`
    );
    const existingColumns = new Set(columns.map(column => column.COLUMN_NAME));

    if (!existingColumns.has("fulfillment_type")) {
        await db.execute(
            `ALTER TABLE customer_orders
             ADD COLUMN fulfillment_type ENUM('delivery', 'pickup') NOT NULL DEFAULT 'delivery'
             AFTER delivery_address`
        );
    }
    await db.execute(
        `ALTER TABLE customer_orders
         MODIFY COLUMN fulfillment_type ENUM('delivery', 'pickup', 'dine_in') NOT NULL DEFAULT 'delivery'`
    );
    if (!existingColumns.has("pickup_time")) {
        await db.execute(
            `ALTER TABLE customer_orders
             ADD COLUMN pickup_time TIME NULL AFTER fulfillment_type`
        );
    }
    if (!existingColumns.has("pickup_status")) {
        await db.execute(
            `ALTER TABLE customer_orders
             ADD COLUMN pickup_status ENUM('scheduled', 'ready', 'picked_up') NOT NULL DEFAULT 'scheduled'
             AFTER pickup_time`
        );
    }
}

async function ensurePaymentSchema() {
    await db.execute(
        `ALTER TABLE customer_orders
         MODIFY COLUMN payment_status ENUM('Unpaid', 'Pending', 'Paid', 'Failed', 'Cancelled', 'Refunded', 'Voided')
         NOT NULL DEFAULT 'Unpaid'`
    );
    await db.execute(`
        CREATE TABLE IF NOT EXISTS payment_records (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            order_id BIGINT NOT NULL,
            payment_method VARCHAR(50) NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'Pending',
            reference VARCHAR(100) NULL,
            received_by_email VARCHAR(190) NULL,
            proof_reference VARCHAR(100) NULL,
            proof_image_data MEDIUMTEXT NULL,
            is_walk_in BOOLEAN NOT NULL DEFAULT FALSE,
            paid_at DATETIME NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_payment_records_order (order_id),
            INDEX idx_payment_records_status_date (status, created_at),
            CONSTRAINT fk_payment_records_order FOREIGN KEY (order_id)
                REFERENCES customer_orders(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS payment_action_history (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            payment_id BIGINT UNSIGNED NOT NULL,
            previous_status VARCHAR(20) NULL,
            new_status VARCHAR(20) NOT NULL,
            action_by_email VARCHAR(190) NULL,
            note VARCHAR(500) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_payment_action_history_payment (payment_id, created_at),
            CONSTRAINT fk_payment_action_history_payment FOREIGN KEY (payment_id)
                REFERENCES payment_records(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.execute(`
        INSERT INTO payment_records (order_id, payment_method, amount, status, reference, paid_at, is_walk_in)
        SELECT co.id, co.payment_method, co.total,
               CASE WHEN co.payment_status = 'Unpaid' THEN 'Pending' ELSE co.payment_status END,
               co.payment_reference, co.payment_paid_at, co.fulfillment_type = 'dine_in'
        FROM customer_orders co
        WHERE NOT EXISTS (SELECT 1 FROM payment_records p WHERE p.order_id = co.id)
    `);
}

function paymentDisplayStatus(status) {
    return status === "Unpaid" ? "Pending" : status;
}

async function getPaymentHistory(url, paymentId = null) {
    if (paymentId) {
        const numericId = Number(String(paymentId).replace(/^PAY-/i, ""));
        if (!Number.isSafeInteger(numericId) || numericId < 1) return null;
        const [rows] = await db.execute(
            `SELECT p.id, p.order_id, p.payment_method, p.amount, p.status, p.reference,
                    p.received_by_email, p.proof_reference, p.proof_image_data, p.is_walk_in,
                    p.paid_at, p.created_at, co.order_number, co.customer_name, co.customer_email,
                    co.customer_phone, co.delivery_address, co.fulfillment_type, co.subtotal,
                    co.delivery_fee, co.total
             FROM payment_records p INNER JOIN customer_orders co ON co.id = p.order_id
             WHERE p.id = ? LIMIT 1`, [numericId]
        );
        if (!rows.length) return null;
        const row = rows[0];
        const [items] = await db.execute(
            `SELECT product_name AS name, product_price AS price, quantity, line_total AS lineTotal,
                    selected_size AS size FROM order_items WHERE order_id = ? ORDER BY id`, [row.order_id]
        );
        const [history] = await db.execute(
            `SELECT previous_status AS previousStatus, new_status AS newStatus,
                    action_by_email AS actionBy, note, created_at AS createdAt
             FROM payment_action_history WHERE payment_id = ? ORDER BY created_at DESC, id DESC`, [numericId]
        );
        return {
            id: `PAY-${String(row.id).padStart(6, "0")}`, orderId: row.order_number,
            customer: row.customer_name, email: row.customer_email, phone: row.customer_phone,
            address: row.delivery_address, fulfillmentType: row.fulfillment_type,
            amount: Number(row.amount), subtotal: Number(row.subtotal), deliveryFee: Number(row.delivery_fee),
            method: row.payment_method, status: paymentDisplayStatus(row.status),
            reference: row.reference || "—", proofReference: row.proof_reference,
            proofImageData: row.proof_image_data, receivedBy: row.received_by_email || "—",
            walkIn: Boolean(row.is_walk_in), paidAt: row.paid_at, createdAt: row.created_at,
            items: items.map(item => ({ ...item, price: Number(item.price), lineTotal: Number(item.lineTotal) })),
            history
        };
    }
    const conditions = [];
    const params = [];
    const search = cleanText(url.searchParams.get("search"), 120);
    const status = cleanText(url.searchParams.get("status"), 20);
    const method = cleanText(url.searchParams.get("method"), 50);
    const date = cleanText(url.searchParams.get("date"), 10);
    if (search) {
        conditions.push("(co.order_number LIKE ? OR co.customer_name LIKE ? OR co.customer_phone LIKE ? OR p.reference LIKE ? OR CAST(p.id AS CHAR) LIKE ?)");
        for (let i = 0; i < 5; i++) params.push(`%${search}%`);
    }
    if (status && status !== "all") {
        if (status === "Refunded") conditions.push("p.status IN ('Refunded', 'Voided')");
        else { conditions.push("p.status = ?"); params.push(status === "Completed" || status === "Successful" ? "Paid" : status); }
    }
    if (method && method !== "all") { conditions.push("p.payment_method = ?"); params.push(method); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { conditions.push("DATE(p.created_at) = ?"); params.push(date); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize")) || 10));
    const [[count]] = await db.execute(
        `SELECT COUNT(*) AS total FROM payment_records p INNER JOIN customer_orders co ON co.id = p.order_id ${where}`, params
    );
    const [rows] = await db.execute(
        `SELECT p.id, p.order_id, p.payment_method, p.amount, p.status, p.reference,
                p.received_by_email, p.is_walk_in, p.paid_at, p.created_at,
                co.order_number, co.customer_name, co.customer_phone, co.fulfillment_type
         FROM payment_records p INNER JOIN customer_orders co ON co.id = p.order_id
         ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize]
    );
    return {
        total: Number(count.total), page, pageSize,
        payments: rows.map(row => ({
            id: `PAY-${String(row.id).padStart(6, "0")}`, orderId: row.order_number,
            customer: row.customer_name, phone: row.customer_phone,
            amount: Number(row.amount), method: row.payment_method,
            status: paymentDisplayStatus(row.status), reference: row.reference || "—",
            receivedBy: row.received_by_email || "—", walkIn: Boolean(row.is_walk_in),
            fulfillmentType: row.fulfillment_type, paidAt: row.paid_at,
            createdAt: row.created_at
        }))
    };
}

async function updatePaymentAction(session, paymentId, action, note) {
    const targets = { paid: "Paid", refund: "Refunded", pending: "Pending", void: "Voided" };
    const nextStatus = targets[action];
    if (!nextStatus) return { status: 400, data: { success: false, message: "Choose a valid payment action." } };
    const id = Number(String(paymentId).replace(/^PAY-/i, ""));
    if (!Number.isSafeInteger(id) || id < 1) return { status: 400, data: { success: false, message: "Invalid payment ID." } };
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
            `SELECT p.*, co.payment_method AS orderPaymentMethod FROM payment_records p
             INNER JOIN customer_orders co ON co.id = p.order_id WHERE p.id = ? FOR UPDATE`, [id]
        );
        if (!rows.length) { await connection.rollback(); return { status: 404, data: { success: false, message: "Payment not found." } }; }
        const payment = rows[0];
        const previous = paymentDisplayStatus(payment.status);
        const allowed = { Pending: ["Paid", "Voided"], Paid: ["Refunded", "Pending"], Refunded: [], Voided: [], Failed: ["Pending", "Voided"], Cancelled: [] };
        if (!allowed[previous]?.includes(nextStatus)) {
            await connection.rollback();
            return { status: 409, data: { success: false, message: `Cannot change ${previous} to ${nextStatus}.` } };
        }
        if (nextStatus === "Paid" && payment.is_walk_in && payment.payment_method === "GCash" && !payment.proof_reference && !payment.proof_image_data) {
            await connection.rollback();
            return { status: 409, data: { success: false, message: "Review a GCash reference or receipt before marking this walk-in payment paid." } };
        }
        await connection.execute(
            `UPDATE payment_records SET status = ?, received_by_email = ?, paid_at = ? WHERE id = ?`,
            [nextStatus, session.email, nextStatus === "Paid" ? new Date() : null, id]
        );
        await connection.execute(
            `UPDATE customer_orders SET payment_status = ?, payment_paid_at = ? WHERE id = ?`,
            [nextStatus, nextStatus === "Paid" ? new Date() : null, payment.order_id]
        );
        await connection.execute(
            `INSERT INTO payment_action_history (payment_id, previous_status, new_status, action_by_email, note)
             VALUES (?, ?, ?, ?, ?)`, [id, previous, nextStatus, session.email, cleanText(note, 500) || null]
        );
        await connection.commit();
        return { status: 200, data: { success: true, message: `Payment marked ${nextStatus.toLowerCase()}.`, status: nextStatus } };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
}

async function startServer() {
    try {
        const connection = await db.getConnection();
        console.log("MySQL database connected: jolies_pizza");
        connection.release();

        await ensureOrderFulfillmentColumns();
        await ensurePaymentSchema();
        await ensureInventoryTables();
        await ensureMenuManagementColumns();
        await ensureStaffManagementSchema();
        await ensureAdminSettingsSchema();
        await ensureStaffBusinessReportsSchema();
        await seedInventoryCatalog();

        await db.execute(`
            CREATE TABLE IF NOT EXISTS api_sessions (
                token_hash CHAR(64) NOT NULL PRIMARY KEY,
                email VARCHAR(190) NOT NULL,
                role VARCHAR(20) NOT NULL,
                expires_at DATETIME NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_api_sessions_email (email),
                INDEX idx_api_sessions_expiry (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS delivery_assignments (
                order_id BIGINT NOT NULL PRIMARY KEY,
                assigned_by_email VARCHAR(190) NOT NULL,
                rider_name VARCHAR(190) NOT NULL,
                rider_phone VARCHAR(30) NOT NULL,
                vehicle_description VARCHAR(100) NULL,
                license_plate VARCHAR(30) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_delivery_assignments_order FOREIGN KEY (order_id)
                    REFERENCES customer_orders(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS delivery_status_history (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                order_id BIGINT NOT NULL,
                status VARCHAR(40) NOT NULL,
                changed_by_email VARCHAR(190) NULL,
                note VARCHAR(500) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_delivery_status_history_order (order_id, created_at),
                CONSTRAINT fk_delivery_status_history_order FOREIGN KEY (order_id)
                    REFERENCES customer_orders(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.execute(`
            INSERT INTO delivery_status_history (order_id, status, changed_by_email, note)
            SELECT co.id, co.status, NULL, 'Imported from existing order status.'
            FROM customer_orders co
            WHERE co.fulfillment_type = 'delivery'
              AND NOT EXISTS (
                  SELECT 1 FROM delivery_status_history h WHERE h.order_id = co.id
              )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS delivery_tracking (
                order_id BIGINT NOT NULL PRIMARY KEY,
                rider_email VARCHAR(190) NOT NULL,
                latitude DECIMAL(10,7) NULL,
                longitude DECIMAL(10,7) NULL,
                accuracy DECIMAL(8,2) NULL,
                speed DECIMAL(8,2) NULL,
                heading DECIMAL(6,2) NULL,
                tracking_active BOOLEAN NOT NULL DEFAULT TRUE,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_delivery_tracking_rider (rider_email, tracking_active),
                CONSTRAINT fk_delivery_tracking_order FOREIGN KEY (order_id)
                    REFERENCES customer_orders(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        // CREATE TABLE IF NOT EXISTS does not update existing installations.
        // Add GPS metadata columns to older delivery_tracking tables in place.
        const [deliveryTrackingColumns] = await db.execute(
            `SELECT COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delivery_tracking'`
        );
        const existingTrackingColumns = new Set(deliveryTrackingColumns.map(column => column.COLUMN_NAME));
        for (const [column, definition] of [
            ["accuracy", "DECIMAL(8,2) NULL"],
            ["speed", "DECIMAL(8,2) NULL"],
            ["heading", "DECIMAL(6,2) NULL"],
            ["tracking_active", "BOOLEAN NOT NULL DEFAULT TRUE"],
            ["updated_at", "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"]
        ]) {
            if (!existingTrackingColumns.has(column)) {
                await db.execute(`ALTER TABLE delivery_tracking ADD COLUMN ${column} ${definition}`);
            }
        }

        server.listen(PORT, () => {
            console.log(`Jolie's Pizza server running at http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error("MYSQL CONNECTION ERROR:", error.message);
        console.error(
            "Check your MySQL service, username, password, and database name."
        );
        process.exit(1);
    }
}

startServer();
