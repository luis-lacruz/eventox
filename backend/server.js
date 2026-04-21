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
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error("FATAL: JWT_SECRET is not set in .env — server refused to start."); process.exit(1); }

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
// Checks if the logged-in user has is_admin = true — verified against the DB,
// not the JWT, so revoked admin tokens are rejected immediately.
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT is_admin FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!result.rows[0]?.is_admin) {
      return res.status(403).json({ error: "Admin access required." });
    }
    next();
  } catch (err) {
    console.error("requireAdmin error:", err.message);
    return res.status(500).json({ error: "Error verifying admin status." });
  }
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
app.post("/events", authenticateToken, requireAdmin, async (req, res) => {
  const { title, description, category, resolution_source, close_time, image_url, status, opens_at } =
    req.body;

  const ALLOWED_CATEGORIES = ['politics', 'economics', 'security', 'sports'];
  const safeCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'politics';

  if (!title) {
    return res.status(400).json({ error: "Title is required" });
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
app.post("/events/:id/resolve", authenticateToken, requireAdmin, async (req, res) => {
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
app.post("/bets", authenticateToken, async (req, res) => {
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
app.post("/bets/:id/sell", authenticateToken, async (req, res) => {
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
app.get("/bets/mine", authenticateToken, async (req, res) => {
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
app.post("/credits/daily", authenticateToken, async (req, res) => {
  const BONUS_AMOUNT = 200;
  const COOLDOWN_MS = 24 * 60 * 60 * 1000;

  try {
    const userResult = await pool.query(
      "SELECT credits, last_daily_bonus FROM users WHERE id = $1",
      [req.user.id]
    );
    const user = userResult.rows[0];

    if (user.last_daily_bonus) {
      const msSinceClaim = Date.now() - new Date(user.last_daily_bonus).getTime();
      if (msSinceClaim < COOLDOWN_MS) {
        const msLeft = COOLDOWN_MS - msSinceClaim;
        const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
        const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
        return res.status(429).json({
          error: "already_claimed",
          hours_left: hoursLeft,
          minutes_left: minutesLeft,
        });
      }
    }

    const result = await pool.query(
      "UPDATE users SET credits = credits + $1, last_daily_bonus = NOW() WHERE id = $2 RETURNING credits",
      [BONUS_AMOUNT, req.user.id]
    );

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
app.post("/admin/gift-credits", authenticateToken, requireAdmin, async (req, res) => {
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

app.get('/transactions/mine', authenticateToken, async (req, res) => {
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

// ─── Resolution Scheduler ────────────────────────────────────
//
// Runs every 5 minutes (and once at startup):
//   1. Auto-close events whose close_time has passed
//   2. Escalate to 'overdue' if admin hasn't resolved within 24h

async function runResolutionScheduler() {
  try {
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





// ─── Serve Frontend ──────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start Server ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EventoX server running on port ${PORT}`);
  console.log(`→ http://localhost:${PORT}`);
});
