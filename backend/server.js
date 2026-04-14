/**
 * EventoX — Binary Prediction Market API
 *
 * Express server providing REST endpoints for a prediction market
 * focused on Colombian real-world events. Users place YES/NO positions
 * on markets that resolve based on official government data.
 *
 * Stack: Node.js + Express + PostgreSQL + JWT Auth
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");     // Password hashing — never store plain text passwords
const jwt = require("jsonwebtoken");  // Token-based auth — lets users stay logged in

// ─── App Setup ───────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "eventox-dev-secret-change-in-production";

// SALT_ROUNDS controls how many times bcrypt re-hashes the password.
// Higher = more secure but slower. 10 is the standard for most apps.
const SALT_ROUNDS = 10;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Database ────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ─── Request Logger (dev) ────────────────────────────────────

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ─── Auth Middleware ─────────────────────────────────────────
//
// This function sits between the request and your route handler.
// It checks for a valid JWT token in the Authorization header.
// If valid → attaches the user info to req.user and calls next().
// If missing/invalid → sends a 401 error and stops the request.
//
// Usage: add "authenticateToken" to any route that requires login:
//   app.post("/bets", authenticateToken, async (req, res) => { ... })

function authenticateToken(req, res, next) {
  // The client sends: Authorization: Bearer <token>
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // grab just the token part

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    // jwt.verify checks if the token is valid and not expired.
    // If valid, it returns the payload we stored when creating the token.
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // now every route after this can use req.user.id, req.user.username, etc.
    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token." });
  }
}

// Admin-only middleware — use AFTER authenticateToken
// Checks if the logged-in user has is_admin = true
function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// ─── Health Checks ───────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/health/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ ok: true, time: result.rows[0].now });
  } catch (err) {
    console.error("Database health check failed:", err.message);
    res.status(500).json({ ok: false, error: "Database unreachable" });
  }
});

// ─── Authentication ──────────────────────────────────────────

/**
 * POST /auth/register
 * Create a new user account.
 * Body: { username, email, password }
 *
 * Flow:
 * 1. Check if username or email already exists
 * 2. Hash the password (never store plain text!)
 * 3. Insert user into database
 * 4. Return a JWT token so they're logged in immediately
 */
app.post("/auth/register", async (req, res) => {
  const { username, email, password } = req.body;

  // Validate all fields are present
  if (!username || !email || !password) {
    return res.status(400).json({ error: "Username, email, and password are required." });
  }

  // Validate password length
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    // Check if user already exists
    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1 OR email = $2",
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Username or email already taken." });
    }

    // Hash the password — bcrypt adds a random "salt" automatically,
    // so even identical passwords produce different hashes.
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert the new user — they start with 1,000 credits
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, credits, is_admin, created_at`,
      [username, email, passwordHash]
    );

    const user = result.rows[0];

    // Create a JWT token — this is what the frontend stores to stay logged in.
    // The token contains the user's id, username, and admin status.
    // expiresIn: "7d" means the token is valid for 7 days.
    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({ token, user });
  } catch (err) {
    console.error("Registration error:", err.message);
    res.status(500).json({ error: "Registration failed." });
  }
});

/**
 * POST /auth/login
 * Log in with existing credentials.
 * Body: { email, password }
 *
 * Flow:
 * 1. Find user by email
 * 2. Compare password against stored hash
 * 3. If match → return JWT token
 * 4. If no match → return generic error (don't reveal which field was wrong)
 */
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      // Generic message — don't tell attackers whether the email exists
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = result.rows[0];

    // bcrypt.compare hashes the provided password and checks if it
    // matches the stored hash. Returns true/false.
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Return user info (without password_hash!)
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        credits: user.credits,
        is_admin: user.is_admin,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed." });
  }
});

/**
 * GET /auth/me
 * Returns the currently logged-in user's info.
 * Requires a valid token — used by the frontend to check if still logged in.
 */
app.get("/auth/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, credits, is_admin, created_at FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Auth check error:", err.message);
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

// ─── Events (Markets) ───────────────────────────────────────

/**
 * GET /events
 * Returns all markets, newest first.
 * Public — no auth required (anyone can browse markets).
 */
app.get("/events", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM events ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching events:", err.message);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

/**
 * POST /events
 * Create a new market. Admin only.
 * Body: { title, description?, category?, resolution_source?, close_time? }
 */
app.post("/events", authenticateToken, requireAdmin, async (req, res) => {
  const { title, description, category, resolution_source, close_time } =
    req.body;

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO events (title, description, category, resolution_source, close_time)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        title,
        description || null,
        category || "politics",
        resolution_source || null,
        close_time || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating event:", err.message);
    res.status(500).json({ error: "Failed to create event" });
  }
});

// ─── Positions (Bets) ───────────────────────────────────────

/**
 * POST /bets
 * Place a YES or NO position on a market. Requires login.
 * Body: { event_id, position: "yes"|"no", amount? }
 *
 * Flow:
 * 1. Verify user is logged in (authenticateToken)
 * 2. Check user has enough credits
 * 3. Deduct credits from user
 * 4. Record the position
 */
app.post("/bets", authenticateToken, async (req, res) => {
  const { event_id, position, amount } = req.body;
  const betAmount = amount || 100;

  if (!event_id || !position) {
    return res.status(400).json({ error: "event_id and position are required" });
  }

  if (!["yes", "no"].includes(position.toLowerCase())) {
    return res.status(400).json({ error: 'Position must be "yes" or "no"' });
  }

  try {
    // Check user's current credits
    const userResult = await pool.query(
      "SELECT credits FROM users WHERE id = $1",
      [req.user.id]
    );

    const userCredits = userResult.rows[0].credits;

    if (userCredits < betAmount) {
      return res.status(400).json({
        error: "Insufficient credits.",
        credits: userCredits,
        required: betAmount,
      });
    }

    // Deduct credits from user
    await pool.query(
      "UPDATE users SET credits = credits - $1 WHERE id = $2",
      [betAmount, req.user.id]
    );

    // Record the position with the user_id
    const result = await pool.query(
      `INSERT INTO bets (event_id, user_id, position, amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [event_id, req.user.id, position.toLowerCase(), betAmount]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error placing bet:", err.message);
    res.status(500).json({ error: "Failed to place position" });
  }
});

/**
 * GET /bets/mine
 * Returns all positions for the currently logged-in user.
 * Joins with events table to show market titles.
 */
app.get("/bets/mine", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, e.title AS event_title, e.status AS event_status
       FROM bets b
       JOIN events e ON b.event_id = e.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching user bets:", err.message);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

// ─── Leaderboard ─────────────────────────────────────────────

/**
 * GET /leaderboard
 * Returns top users ranked by credits. Public endpoint.
 */
app.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, credits, created_at
       FROM users
       ORDER BY credits DESC
       LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching leaderboard:", err.message);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ─── Serve Frontend ──────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start Server ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EventoX server running on port ${PORT}`);
  console.log(`→ http://localhost:${PORT}`);
});
