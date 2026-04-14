/**
 * EventoX — Binary Prediction Market API
 *
 * Express server providing REST endpoints for a prediction market
 * focused on Colombian real-world events. Users place YES/NO positions
 * on markets that resolve based on official government data.
 *
 * Stack: Node.js + Express + PostgreSQL
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

// ─── App Setup ───────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

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

// ─── Events (Markets) ───────────────────────────────────────

/**
 * GET /events
 * Returns all markets, newest first.
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
 * Create a new market. Expects JSON body:
 *   { title, description?, category?, resolution_source?, close_time? }
 */
app.post("/events", async (req, res) => {
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
 * Place a YES or NO position on a market. Expects JSON body:
 *   { event_id, position: "yes"|"no", amount? }
 */
app.post("/bets", async (req, res) => {
  const { event_id, position, amount } = req.body;

  if (!event_id || !position) {
    return res.status(400).json({ error: "event_id and position are required" });
  }

  if (!["yes", "no"].includes(position.toLowerCase())) {
    return res.status(400).json({ error: 'Position must be "yes" or "no"' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bets (event_id, position, amount)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [event_id, position.toLowerCase(), amount || 100]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error placing bet:", err.message);
    res.status(500).json({ error: "Failed to place position" });
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
