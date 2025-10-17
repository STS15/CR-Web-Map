const express = require("express");
const path = require("path");
const session = require("express-session");
const flash = require("connect-flash");
const compression = require("compression");
const helmet = require("helmet");
const morgan = require("morgan");
const dotenv = require("dotenv");
const { readAllFeatures, upsertFeature, deleteFeatureById } = require("./store");
const { readAllWalkways, upsertWalkway, deleteWalkwayById } = require("./walkwayStore");


dotenv.config();

/**
 * Initializes and configures the Express application.
 * @returns {import('express').Express} Configured Express app instance.
 */
function createApp() {
    const app = express();

    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "views"));

    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: true,
                directives: {
                    "default-src": ["'self'"],
                    "img-src": [
                        "'self'",
                        "data:",
                        "https://www.redwoods.edu",
                        "https://*.tile.openstreetmap.org",
                        "https://unpkg.com",
                        "https://server.arcgisonline.com"
                    ],
                    "script-src": [
                        "'self'",
                        "https://unpkg.com",
                        "'unsafe-inline'",
                        "'unsafe-eval'",
                    ],
                    "style-src": [
                        "'self'",
                        "'unsafe-inline'",
                        "https://unpkg.com",
                        "https://fonts.googleapis.com"
                    ],
                    "font-src": [
                        "'self'",
                        "https://fonts.gstatic.com"
                    ],
                    "connect-src": ["'self'"],
                    "frame-src": ["'self'"]
                }
            }
        })
    );
    app.use(compression());
    app.use(morgan("dev"));
    app.use(express.json({ limit: "2mb" }));
    app.use(express.urlencoded({ extended: true }));
    app.use(
        session({
            secret: process.env.SESSION_SECRET || "dev-secret",
            resave: false,
            saveUninitialized: false,
            cookie: { sameSite: "lax" }
        })
    );
    app.use(flash());

    app.use("/static", express.static(path.join(__dirname, "public")));

    app.get("/", handleHome);
    app.get("/admin", requireAuth, handleAdmin);
    app.post("/login", handleLogin);
    app.post("/logout", handleLogout);

    app.get("/api/features", apiGetFeatures);
    app.post("/api/features", requireAuth, apiCreateOrUpdateFeature);
    app.delete("/api/features/:id", requireAuth, apiDeleteFeature);

    app.get("/api/walkways", async (_req, res) => {
        const features = await readAllWalkways();
        res.json({ type: "FeatureCollection", features });
    });
    app.post("/api/walkways", requireAuth, async (req, res) => {
        const saved = await upsertWalkway(req.body);
        res.json(saved);
    });
    app.delete("/api/walkways/:id", requireAuth, async (req, res) => {
        await deleteWalkwayById(req.params.id);
        res.json({ ok: true });
    });

    app.use(handleNotFound);
    app.use(handleError);

    return app;
}

/**
 * Renders the public map view.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleHome(req, res) {
    const messages = { success: req.flash("success"), error: req.flash("error") };
    res.render("map", { isAdmin: !!req.session.isAdmin, messages });
}

/**
 * Renders the admin editor view.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleAdmin(req, res) {
    const messages = { success: req.flash("success"), error: req.flash("error") };
    res.render("admin", { isAdmin: !!req.session.isAdmin, messages });
}

/**
 * Authenticates a user using a shared admin password.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleLogin(req, res) {
    const { password } = req.body;
    if ((process.env.ADMIN_PASSWORD || "admin") === password) {
        req.session.isAdmin = true;
        req.flash("success", "Logged in.");
        res.redirect("/admin");
    } else {
        req.flash("error", "Invalid password.");
        res.redirect("/");
    }
}

/**
 * Logs out the current session.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleLogout(req, res) {
    req.session.isAdmin = false;
    req.flash("success", "Logged out.");
    res.redirect("/");
}

/**
 * Express middleware that ensures the user is authenticated.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireAuth(req, res, next) {
    if (req.session?.isAdmin) return next();
    return res.status(401).json({ error: "Unauthorized" });
}

/**
 * Returns all stored GeoJSON features.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function apiGetFeatures(_req, res) {
    const features = await readAllFeatures();
    res.json({ type: "FeatureCollection", features });
}

/**
 * Creates or updates a GeoJSON feature.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function apiCreateOrUpdateFeature(req, res) {
    const feature = req.body;
    const saved = await upsertFeature(feature);
    res.json(saved);
}

/**
 * Deletes a feature by id.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function apiDeleteFeature(req, res) {
    await deleteFeatureById(req.params.id);
    res.json({ ok: true });
}

/**
 * Handles 404 responses.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
function handleNotFound(_req, res) {
    res.status(404).render("404", { isAdmin: false, messages: {} });
}

/**
 * Global error handler.
 * @param {Error} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
function handleError(err, _req, res, _next) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
}

const port = process.env.PORT || 5000;
createApp().listen(port, () => {
    console.log(`CR WebApp listening on http://localhost:${port}`);
});
