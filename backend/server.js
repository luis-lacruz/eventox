/**
 * EventoX — Binary Prediction Market API
 *
 * Express server providing REST endpoints for a prediction market
 * focused on Colombian real-world events. Users place YES/NO positions
 * on markets that resolve based on official government data.
 *
 * Stack: Node.js + Express + PostgreSQL
 * Mode: Open demo — no login required, shared demo user
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const nodemailer = require('nodemailer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: 'eventox', transformation: [{ width: 1200, crop: 'limit' }] },
      (err, result) => err ? reject(err) : resolve(result)
    ).end(buffer);
  });
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ─── App Setup ───────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.APP_URL,            // e.g. https://eventox-production.up.railway.app
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, mobile apps) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

// Security headers — disables powered-by, sets XSS/frame/MIME protections.
// CSP is relaxed to allow the CDN scripts (Chart.js, Google Fonts) the app needs.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc:  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:   ["'self'", "https://fonts.gstatic.com"],
      imgSrc:    ["'self'", "data:", "https://res.cloudinary.com", "https:"],
      connectSrc:["'self'"],
    }
  }
}));

// ─── Rate Limiters ───────────────────────────────────────────

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' }
});

const betLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Demasiadas apuestas por minuto.' }
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiadas subidas de imagen. Intenta en 15 minutos.' }
});

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Límite de analytics alcanzado.' }
});

app.use(generalLimiter);
app.use(express.json({ limit: '50kb' }));
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

// ─── Demo User ──────────────────────────────────────────────
//
// Open demo mode: a single shared user is auto-created on first request.
// All operations run as this user — no login required.

const DEMO_USERNAME = 'demo';
const DEMO_EMAIL = 'demo@eventox.co';
let _demoUser = null;

async function ensureDemoUser() {
  if (_demoUser) return _demoUser;
  const existing = await pool.query(
    "SELECT id, username, email, credits, is_admin, created_at FROM users WHERE username = $1",
    [DEMO_USERNAME]
  );
  if (existing.rows.length > 0) {
    _demoUser = existing.rows[0];
  } else {
    const created = await pool.query(
      `INSERT INTO users (username, email, password_hash, is_admin)
       VALUES ($1, $2, 'demo_no_login', true)
       RETURNING id, username, email, credits, is_admin, created_at`,
      [DEMO_USERNAME, DEMO_EMAIL]
    );
    _demoUser = created.rows[0];
  }
  return _demoUser;
}

async function useDemoUser(req, res, next) {
  try {
    const user = await ensureDemoUser();
    req.user = { id: user.id, username: user.username, is_admin: true };
    next();
  } catch (err) {
    console.error("useDemoUser error:", err.message);
    return res.status(500).json({ error: "Error loading demo user." });
  }
}

// ─── Image Upload ─────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.post('/admin/upload-image', uploadLimiter, useDemoUser,
  upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    try {
      const result = await uploadToCloudinary(req.file.buffer);
      res.json({ url: result.secure_url });
    } catch (err) {
      console.error('Cloudinary upload error:', err.message);
      res.status(500).json({ error: 'Error al subir la imagen.' });
    }
  }
);

app.patch('/events/:id/image', uploadLimiter, useDemoUser,
  upload.single('image'), async (req, res) => {
    const eventId = req.params.id;
    try {
      let imageUrl = req.body.image_url || null;

      if (req.file) {
        const result = await uploadToCloudinary(req.file.buffer);
        imageUrl = result.secure_url;
      }

      if (!imageUrl) {
        return res.status(400).json({ error: 'No image provided.' });
      }

      const result = await pool.query(
        `UPDATE events SET image_url = $1 WHERE id = $2 RETURNING id, title, image_url`,
        [imageUrl, eventId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Market not found.' });
      }

      res.json({ message: 'Image updated.', event: result.rows[0] });
    } catch (err) {
      console.error('Image update error:', err.message);
      res.status(500).json({ error: 'Error updating image.' });
    }
  }
);

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

// ─── Demo Auth ──────────────────────────────────────────────

app.get("/auth/demo", async (req, res) => {
  try {
    const user = await ensureDemoUser();
    const fresh = await pool.query(
      "SELECT id, username, email, credits, is_admin, created_at FROM users WHERE id = $1",
      [user.id]
    );
    res.json(fresh.rows[0]);
  } catch (err) {
    console.error("Demo auth error:", err.message);
    res.status(500).json({ error: "Failed to load demo user." });
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
      "SELECT * FROM events WHERE status != 'upcoming' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching events:", err.message);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// ─── Upcoming Markets ────────────────────────────────────────

app.get("/events/upcoming", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM events WHERE status = 'upcoming' ORDER BY opens_at ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching upcoming events:", err.message);
    res.status(500).json({ error: "Failed to fetch upcoming events" });
  }
});

app.post('/events/:id/notify', useDemoUser, async (req, res) => {
  const eventId = req.params.id;
  try {
    await pool.query(
      `INSERT INTO market_notifications (user_id, event_id)
       VALUES ($1, $2) ON CONFLICT (user_id, event_id) DO NOTHING`,
      [req.user.id, eventId]
    );
    res.json({ message: 'Te notificaremos cuando este mercado abra.' });
  } catch (err) {
    console.error('Notify error:', err.message);
    res.status(500).json({ error: 'Error al registrar notificación.' });
  }
});

app.post("/events/:id/watch", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "UPDATE events SET watch_count = COALESCE(watch_count, 0) + 1 WHERE id = $1 RETURNING watch_count",
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Market not found" });
    res.json({ watch_count: result.rows[0].watch_count });
  } catch (err) {
    console.error("Error watching event:", err.message);
    res.status(500).json({ error: "Failed to watch event" });
  }
});

app.get("/events/:id/watching", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT watch_count FROM events WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Market not found" });
    res.json({ watch_count: result.rows[0].watch_count || 0 });
  } catch (err) {
    console.error("Error fetching watch count:", err.message);
    res.status(500).json({ error: "Failed to fetch watch count" });
  }
});

/**
 * POST /events
 * Create a new market. Admin only.
 * Body: { title, description?, category?, resolution_source?, close_time?, status?, opens_at? }
 */
app.post("/events", useDemoUser, async (req, res) => {
  const { title, description, category, resolution_source, close_time, image_url, status, opens_at } =
    req.body;

  const ALLOWED_CATEGORIES = ['politics', 'economics', 'security', 'sports'];
  const safeCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'politics';

  if (!title || typeof title !== 'string' || title.trim().length < 5 || title.length > 300) {
    return res.status(400).json({ error: "Title is required (5–300 characters)." });
  }
  if (description && (typeof description !== 'string' || description.length > 1000)) {
    return res.status(400).json({ error: "Description must be under 1000 characters." });
  }
  if (resolution_source && (typeof resolution_source !== 'string' || resolution_source.length > 200)) {
    return res.status(400).json({ error: "Resolution source must be under 200 characters." });
  }

  const eventStatus = status === "upcoming" ? "upcoming" : "open";

  try {
    const result = await pool.query(
      `INSERT INTO events (title, description, category, resolution_source, close_time, image_url, status, opens_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        title,
        description || null,
        safeCategory,
        resolution_source || null,
        close_time || null,
        image_url || null,
        eventStatus,
        opens_at || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating event:", err.message);
    res.status(500).json({ error: "Failed to create event" });
  }
});

/**
 * POST /events/:id/resolve
 * Admin resolves a market as YES or NO.
 * Body: { result: "yes"|"no" }
 *
 * Flow:
 * 1. Mark the event as resolved
 * 2. Find all winning bets
 * 3. Pay out winners (2x their stake — they risked credits and won)
 * 4. Return summary of payouts
 */
app.post("/events/:id/resolve", useDemoUser, async (req, res) => {
  const eventId = req.params.id;
  const { result } = req.body;

  if (!result || !["yes", "no"].includes(result.toLowerCase())) {
    return res.status(400).json({ error: 'Result must be "yes" or "no".' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check event exists and is still open
    const eventResult = await client.query("SELECT * FROM events WHERE id = $1", [eventId]);
    if (eventResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Market not found." });
    }
    if (eventResult.rows[0].status === 'resolved') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Market already resolved." });
    }

    // Mark as resolved
    await client.query(
      "UPDATE events SET status = 'resolved', resolved = true, outcome = $1 WHERE id = $2",
      [result.toLowerCase(), eventId]
    );

    // Pay out winning open positions (entry-price aware: payout = amount × 100 / entry_price)
    const winningBets = await client.query(
      `SELECT id, user_id, amount, entry_price
       FROM bets WHERE event_id = $1 AND position = $2 AND status = 'OPEN'`,
      [eventId, result.toLowerCase()]
    );

    let totalPaid = 0;
    for (const bet of winningBets.rows) {
      const ep = bet.entry_price || 50;
      const payout = Math.round(bet.amount * 100 / ep); // at ep=50 this is 2× as before
      const pnl = payout - bet.amount;
      await client.query(
        "UPDATE users SET credits = credits + $1 WHERE id = $2",
        [payout, bet.user_id]
      );
      await client.query(
        "UPDATE bets SET status = 'CLOSED', pnl = $1 WHERE id = $2",
        [pnl, bet.id]
      );
      logTransaction(bet.user_id, parseInt(eventId), 'winnings', payout,
        `Ganancia en "${eventResult.rows[0].title}" (${result.toUpperCase()})`, client);
      totalPaid += payout;
    }

    // Close losing open positions (no payout, record negative pnl)
    const losingBets = await client.query(
      `SELECT user_id, amount FROM bets WHERE event_id = $1 AND position != $2 AND status = 'OPEN'`,
      [eventId, result.toLowerCase()]
    );
    await client.query(
      `UPDATE bets SET status = 'CLOSED', pnl = -amount
       WHERE event_id = $1 AND position != $2 AND status = 'OPEN'`,
      [eventId, result.toLowerCase()]
    );
    for (const lb of losingBets.rows) {
      logTransaction(lb.user_id, parseInt(eventId), 'loss', lb.amount,
        `Pérdida en "${eventResult.rows[0].title}" (${result.toUpperCase()})`, client);
    }

    await client.query('COMMIT');
    res.json({
      message: `Mercado resuelto como ${result.toUpperCase()}.`,
      winners: winningBets.rows.length,
      total_paid: totalPaid,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Resolution error:', err.message);
    res.status(500).json({ error: "Error al resolver el mercado." });
  } finally {
    client.release();
  }
});



// ─── Positions (Bets) ───────────────────────────────────────

// ─── Helpers: Price History & Transaction Log ────────────────

async function recordPriceHistory(eventId, yesPrice, noPrice, db = pool) {
  try {
    await db.query(
      'INSERT INTO price_history (event_id, yes_price, no_price) VALUES ($1, $2, $3)',
      [eventId, yesPrice, noPrice]
    );
  } catch (err) {
    console.error('recordPriceHistory error:', err.message);
  }
}

async function logTransaction(userId, eventId, type, amount, description, db = pool) {
  try {
    await db.query(
      'INSERT INTO transactions (user_id, event_id, type, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [userId, eventId, type, amount, description]
    );
  } catch (err) {
    console.error('logTransaction error:', err.message);
  }
}

/**
 * Helper: update market prices after a buy or sell.
 * Buying YES (or selling NO) pushes yes_price up.
 * Buying NO (or selling YES) pushes yes_price down.
 * Impact: 1¢ per 100 credits. yes_price + no_price always = 100.
 */
async function updatePrices(eventId, side, amount, isBuy, db = pool) {
  const impact = Math.max(1, Math.floor(amount / 100));
  const direction = (side === "yes") === isBuy ? 1 : -1;
  const evRes = await db.query("SELECT yes_price FROM events WHERE id = $1", [eventId]);
  if (evRes.rows.length === 0) return;
  const newYes = Math.max(1, Math.min(99, evRes.rows[0].yes_price + impact * direction));
  await db.query(
    "UPDATE events SET yes_price = $1, no_price = $2 WHERE id = $3",
    [newYes, 100 - newYes, eventId]
  );
  recordPriceHistory(eventId, newYes, 100 - newYes, db);
}

/**
 * POST /bets
 * Buy a YES or NO position. Records entry price and moves market price.
 * Body: { event_id, position: "yes"|"no", amount? }
 */
app.post("/bets", betLimiter, useDemoUser, async (req, res) => {
  const { event_id, position, amount } = req.body;
  const betAmount = parseInt(amount, 10);
  if (!Number.isInteger(betAmount) || betAmount < 1) {
    return res.status(400).json({ error: "El monto debe ser un número entero positivo." });
  }
  if (betAmount > 10000) {
    return res.status(400).json({ error: "El monto máximo por apuesta es 10,000 créditos." });
  }

  if (!event_id || !position) {
    return res.status(400).json({ error: "event_id and position are required" });
  }

  if (!["yes", "no"].includes(position.toLowerCase())) {
    return res.status(400).json({ error: 'Position must be "yes" or "no"' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get event to verify it's open and read current price
    const eventResult = await client.query("SELECT * FROM events WHERE id = $1", [event_id]);
    if (eventResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Market not found." });
    }
    const event = eventResult.rows[0];
    if (event.status !== "open") {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Market is closed." });
    }
    if (event.close_time && new Date(event.close_time) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Este mercado ya cerró." });
    }

    const entryPrice = position.toLowerCase() === "yes"
      ? (event.yes_price || 50)
      : (event.no_price || 50);

    // Check user's current credits
    const userResult = await client.query(
      "SELECT credits FROM users WHERE id = $1",
      [req.user.id]
    );
    const userCredits = userResult.rows[0].credits;

    if (userCredits < betAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: "Insufficient credits.",
        credits: userCredits,
        required: betAmount,
      });
    }

    // Deduct credits from user
    await client.query(
      "UPDATE users SET credits = credits - $1 WHERE id = $2",
      [betAmount, req.user.id]
    );

    // Record the position with entry price
    const result = await client.query(
      `INSERT INTO bets (event_id, user_id, position, amount, entry_price, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')
       RETURNING *`,
      [event_id, req.user.id, position.toLowerCase(), betAmount, entryPrice]
    );

    // Move market price
    await updatePrices(event_id, position.toLowerCase(), betAmount, true, client);
    logTransaction(req.user.id, event_id, 'bet_placed', betAmount,
      `${position.toUpperCase()} en "${event.title}" a ${entryPrice}¢`, client);

    // Return bet plus updated prices so the frontend can refresh immediately
    const updatedEvent = await client.query(
      "SELECT yes_price, no_price FROM events WHERE id = $1", [event_id]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ...result.rows[0],
      yes_price: updatedEvent.rows[0].yes_price,
      no_price: updatedEvent.rows[0].no_price,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bet placement error:', err.message);
    res.status(500).json({ error: "Error al procesar la apuesta." });
  } finally {
    client.release();
  }
});

/**
 * POST /bets/:id/sell
 * Sell all or part of an open position before market resolution.
 * Body: { sell_amount? }  — omit to sell the full position.
 *
 * Return = sell_amount × current_price / entry_price
 * PnL    = return − sell_amount
 */
app.post("/bets/:id/sell", useDemoUser, async (req, res) => {
  const betId = req.params.id;
  const { sell_amount } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const betResult = await client.query("SELECT * FROM bets WHERE id = $1", [betId]);
    if (betResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Position not found." });
    }
    const bet = betResult.rows[0];

    if (bet.user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: "Not your position." });
    }
    if (bet.status !== "OPEN") {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Position already closed." });
    }
    if (bet.amount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Nothing left to sell." });
    }

    const eventResult = await client.query(
      "SELECT yes_price, no_price, title FROM events WHERE id = $1", [bet.event_id]
    );
    const event = eventResult.rows[0];
    const currentPrice = bet.position === "yes" ? event.yes_price : event.no_price;
    const entryPrice = bet.entry_price || 50;

    // Clamp sell_amount to what the user actually owns
    const sellAmount = sell_amount && parseInt(sell_amount) < bet.amount
      ? parseInt(sell_amount)
      : bet.amount;

    // Credits returned at current price
    const creditsOut = Math.round(sellAmount * currentPrice / entryPrice);
    const pnlDelta = creditsOut - sellAmount;

    // Pay user
    await client.query(
      "UPDATE users SET credits = credits + $1 WHERE id = $2",
      [creditsOut, req.user.id]
    );

    // Update the bet
    const newAmount = bet.amount - sellAmount;
    if (newAmount <= 0) {
      await client.query(
        "UPDATE bets SET amount = 0, status = 'CLOSED', pnl = $1 WHERE id = $2",
        [pnlDelta, betId]
      );
    } else {
      await client.query("UPDATE bets SET amount = $1 WHERE id = $2", [newAmount, betId]);
    }

    // Move market price back (selling = inverse direction of buying)
    await updatePrices(bet.event_id, bet.position, sellAmount, false, client);
    logTransaction(req.user.id, bet.event_id, 'sell', creditsOut,
      `Venta ${bet.position.toUpperCase()} en "${event.title}" (PnL: ${pnlDelta >= 0 ? '+' : ''}${pnlDelta})`, client);

    const userResult = await client.query(
      "SELECT credits FROM users WHERE id = $1", [req.user.id]
    );

    await client.query('COMMIT');
    res.json({
      pnl: pnlDelta,
      credits_out: creditsOut,
      new_credits: userResult.rows[0].credits,
      position_status: newAmount <= 0 ? "CLOSED" : "OPEN",
      remaining_amount: Math.max(0, newAmount),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Sell bet error:', err.message);
    res.status(500).json({ error: "Error al vender la apuesta." });
  } finally {
    client.release();
  }
});

/**
 * GET /bets/mine
 * Returns all positions for the logged-in user, including live market prices
 * so the frontend can compute current value and unrealised PnL.
 */
app.get("/bets/mine", useDemoUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*,
              e.title AS event_title,
              e.status AS event_status,
              e.outcome AS resolved_as,
              e.yes_price,
              e.no_price
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

// ─── Credits ─────────────────────────────────────────────────

/**
 * POST /credits/daily
 * Claim daily login bonus. Awards 200 credits every 24 hours.
 */
app.post("/credits/daily", useDemoUser, async (req, res) => {
  const BONUS_AMOUNT = 200;

  try {
    // Atomic: only updates if 24h have elapsed since last claim — no race condition possible.
    const result = await pool.query(
      `UPDATE users
       SET credits = credits + $1, last_daily_bonus = NOW()
       WHERE id = $2
         AND (last_daily_bonus IS NULL OR last_daily_bonus <= NOW() - INTERVAL '24 hours')
       RETURNING credits`,
      [BONUS_AMOUNT, req.user.id]
    );

    if (result.rows.length === 0) {
      // Cooldown not elapsed — fetch remaining time
      const timeResult = await pool.query(
        "SELECT last_daily_bonus FROM users WHERE id = $1",
        [req.user.id]
      );
      const lastClaim = timeResult.rows[0]?.last_daily_bonus;
      const msLeft = lastClaim
        ? Math.max(0, new Date(lastClaim).getTime() + 24 * 3600 * 1000 - Date.now())
        : 0;
      const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
      const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
      return res.status(429).json({ error: "already_claimed", hours_left: hoursLeft, minutes_left: minutesLeft });
    }

    res.json({
      message: `¡${BONUS_AMOUNT} créditos reclamados!`,
      credits: result.rows[0].credits,
      bonus: BONUS_AMOUNT,
    });
  } catch (err) {
    console.error("Daily bonus error:", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

/**
 * POST /admin/gift-credits
 * Admin gifts credits to a user by username.
 * Body: { username, amount }
 */
app.post("/admin/gift-credits", useDemoUser, async (req, res) => {
  const { username, amount } = req.body;

  const safeAmount = Math.floor(parseInt(amount, 10));
  if (!username || !safeAmount || safeAmount < 1) {
    return res.status(400).json({ error: "Monto inválido." });
  }

  try {
    const result = await pool.query(
      "UPDATE users SET credits = credits + $1 WHERE username = $2 RETURNING id, username, credits",
      [safeAmount, username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({
      message: `${safeAmount} créditos enviados a ${username}.`,
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Gift credits error:", err.message);
    res.status(500).json({ error: "Failed to gift credits." });
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

// ─── Hot Markets ─────────────────────────────────────────────

app.get("/markets/hot", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.title, e.yes_price, e.no_price, e.resolution_source,
              e.close_time, e.status, e.category, e.image_url,
              COUNT(b.id)::int AS total_bets
       FROM bets b
       JOIN events e ON e.id = b.event_id
       WHERE b.created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY e.id
       ORDER BY total_bets DESC
       LIMIT 3`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching hot markets:", err.message);
    res.status(500).json({ error: "Failed to fetch hot markets" });
  }
});

// ─── Price History ───────────────────────────────────────────

app.get('/events/:id/price-history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT yes_price, no_price, recorded_at FROM price_history
       WHERE event_id = $1 ORDER BY recorded_at ASC LIMIT 100`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('price-history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// ─── Transaction History ─────────────────────────────────────

app.get('/transactions/mine', useDemoUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.type, t.amount, t.description, t.created_at,
              e.title AS event_title
       FROM transactions t
       LEFT JOIN events e ON t.event_id = e.id
       WHERE t.user_id = $1
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('transactions/mine error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ─── Email Notifications ─────────────────────────────────────

async function sendMarketOpenEmails(eventId, eventTitle) {
  try {
    const result = await pool.query(
      `SELECT u.email, u.username
       FROM market_notifications mn
       JOIN users u ON u.id = mn.user_id
       WHERE mn.event_id = $1 AND mn.notified = false`,
      [eventId]
    );
    for (const user of result.rows) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: `EventoX — Ya abrió: ${eventTitle}`,
        html: `
          <div style="font-family:sans-serif;max-width:500px">
            <h2 style="color:#c8f135">EventoX</h2>
            <p>Hola ${user.username},</p>
            <p>El mercado que estabas esperando ya está abierto:</p>
            <p><strong>${eventTitle}</strong></p>
            <a href="https://eventox-production.up.railway.app"
               style="background:#c8f135;color:#000;padding:10px 20px;
                      text-decoration:none;border-radius:4px;display:inline-block;
                      margin-top:12px">
              Ver mercado →
            </a>
          </div>
        `
      });
    }
    await pool.query(
      `UPDATE market_notifications SET notified = true WHERE event_id = $1`,
      [eventId]
    );
  } catch (err) {
    console.error('Email send error:', err.message);
  }
}

// ─── Resolution Scheduler ────────────────────────────────────
//
// Runs every 5 minutes (and once at startup):
//   1. Open upcoming events whose opens_at has passed (and email subscribers)
//   2. Auto-close events whose close_time has passed
//   3. Escalate to 'overdue' if admin hasn't resolved within 24h

async function runResolutionScheduler() {
  try {
    const opened = await pool.query(`
      UPDATE events
      SET status = 'open'
      WHERE status = 'upcoming'
        AND opens_at IS NOT NULL
        AND opens_at <= NOW()
      RETURNING id, title`);
    if (opened.rows.length > 0) {
      console.log(`[Scheduler] Opened: ${opened.rows.map(r => r.title).join(', ')}`);
      for (const row of opened.rows) {
        sendMarketOpenEmails(row.id, row.title);
      }
    }

    const closed = await pool.query(`
      UPDATE events
      SET status = 'closed', closed_at = NOW()
      WHERE status = 'open'
        AND close_time IS NOT NULL
        AND close_time <= NOW()
      RETURNING id, title`);
    if (closed.rows.length > 0)
      console.log(`[Scheduler] Auto-closed: ${closed.rows.map(r => r.title).join(', ')}`);

    const overdue = await pool.query(`
      UPDATE events
      SET status = 'overdue'
      WHERE status = 'closed'
        AND closed_at IS NOT NULL
        AND closed_at <= NOW() - INTERVAL '24 hours'
      RETURNING id, title`);
    if (overdue.rows.length > 0)
      console.log(`[Scheduler] Overdue: ${overdue.rows.map(r => r.title).join(', ')}`);
  } catch (err) {
    console.error('[Scheduler] Error:', err.message);
  }
}

runResolutionScheduler();
setInterval(runResolutionScheduler, 5 * 60 * 1000);

// ─── Serve Frontend ──────────────────────────────────────
// ─── Stats ───────────────────────────────────────────────

app.get("/stats", async (req, res) => {
  try {
    const events = await pool.query("SELECT COUNT(*) FROM events");
    const bets = await pool.query("SELECT COUNT(*) FROM bets");
    res.json({
      markets: parseInt(events.rows[0].count),
      positions: parseInt(bets.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});





// ─── Intent Signals ──────────────────────────────────────────

pool.query(`
  CREATE TABLE IF NOT EXISTS intent_signals (
    id         SERIAL PRIMARY KEY,
    event_id   INTEGER REFERENCES events(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    ip         TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).catch(err => console.error('intent_signals setup error:', err.message));

app.post('/analytics/intent', analyticsLimiter, async (req, res) => {
  const { event_id, action } = req.body;
  if (!action || typeof action !== 'string' || action.length > 100) {
    return res.status(400).json({ error: 'action required and must be under 100 characters' });
  }
  if (event_id !== undefined && event_id !== null && !Number.isInteger(Number(event_id))) {
    return res.status(400).json({ error: 'invalid event_id' });
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress;
  try {
    await pool.query(
      `INSERT INTO intent_signals (event_id, action, ip) VALUES ($1, $2, $3)`,
      [event_id || null, action, ip]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log intent' });
  }
});

app.get('/admin/intent-signals', useDemoUser, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(e.title, '(mercado eliminado)') AS market,
        i.action,
        COUNT(*)::int                            AS count,
        MAX(i.created_at)                        AS last_seen
      FROM intent_signals i
      LEFT JOIN events e ON e.id = i.event_id
      GROUP BY e.title, i.action
      ORDER BY count DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch intent signals' });
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
