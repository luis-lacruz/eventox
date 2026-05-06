# EventoX — Architecture Notes

## Overview

EventoX is a monolithic web application: one Express process serving both the REST API and the static frontend. PostgreSQL handles all persistence. Cloudinary handles image storage. Nodemailer sends email alerts. No message queue, no separate workers — the scheduler runs inside the main process on a `setInterval`.

This is deliberate. At MVP scale (~100 users), a monolith is faster to iterate on, easier to reason about, and free of the network latency and operational complexity that microservices introduce without proportional benefit.

---

## System diagram

```
┌──────────────────────────────────────────────────────────┐
│                      Browser (SPA)                        │
│                                                          │
│  index.html — single file, no framework, no build step   │
│                                                          │
│  Market cards · Hot markets widget · Top traders widget  │
│  Bet modal · Sell modal · Portfolio dashboard            │
│  Admin panel · Price history charts (Chart.js)           │
│  Upcoming markets · Leaderboard · Dark/light mode        │
└─────────────────────────┬────────────────────────────────┘
                          │  fetch() — JSON REST
                          ▼
┌──────────────────────────────────────────────────────────┐
│                  Express Server                           │
│                                                          │
│  Middleware stack (in order):                            │
│    CORS whitelist                                        │
│    Helmet (security headers + CSP)                       │
│    Rate limiters (general · bets · uploads · analytics)  │
│    express.json({ limit: '50kb' })                       │
│    express.static (serves index.html + assets)           │
│    useDemoUser (injects shared demo user into req.user)  │
│                                                          │
│  Route groups:                                           │
│    /auth/demo        shared demo user endpoint           │
│    /events           market CRUD + resolution            │
│    /bets             position buy + sell                 │
│    /credits          daily bonus                         │
│    /leaderboard      top users by credits                │
│    /markets/hot      trending by 24 h bet volume        │
│    /transactions     credit audit trail                  │
│    /analytics        intent signal ingestion             │
│    /admin            gift credits, intent report         │
│    /admin/upload-image  Cloudinary proxy                 │
│                                                          │
│  Background scheduler (setInterval 5 min):               │
│    1. Opens upcoming markets whose opens_at has passed   │
│    2. Emails subscribers (via Nodemailer)                │
│    3. Closes open markets past close_time                │
│    4. Escalates unresolved closed markets to 'overdue'   │
└──────┬──────────────────────────┬───────────────────────┘
       │  pg (node-postgres)      │  REST/HTTPS
       ▼                          ▼
┌─────────────┐          ┌─────────────────┐  ┌──────────────┐
│ PostgreSQL  │          │   Cloudinary    │  │  Gmail SMTP  │
│             │          │                 │  │              │
│ 7 tables    │          │ Market cover    │  │ Market-open  │
│ (see below) │          │ images (CDN)    │  │ email alerts │
└─────────────┘          └─────────────────┘  └──────────────┘
```

---

## Data model

### `events` — market definitions and lifecycle state

```
id                SERIAL PK
title             TEXT NOT NULL
description       TEXT
category          TEXT              -- politics | economics | security | sports
status            TEXT              -- upcoming | open | closed | overdue | resolved
outcome           TEXT              -- yes | no (set on resolution)
resolved          BOOLEAN
yes_price         INTEGER           -- 0–100; always yes_price + no_price = 100
no_price          INTEGER
resolution_source TEXT
close_time        TIMESTAMP
opens_at          TIMESTAMP         -- for upcoming markets; scheduler uses this
image_url         TEXT              -- Cloudinary URL
watch_count       INTEGER
closed_at         TIMESTAMP         -- set when scheduler moves to 'closed'
created_at        TIMESTAMP
```

### `users` — accounts and credit balances

```
id               SERIAL PK
username         TEXT UNIQUE
email            TEXT UNIQUE
password_hash    TEXT
credits          INTEGER DEFAULT 1000
is_admin         BOOLEAN DEFAULT FALSE
last_daily_bonus TIMESTAMP          -- used in atomic cooldown UPDATE
created_at       TIMESTAMP
```

### `bets` — open and closed positions

```
id          SERIAL PK
event_id    INTEGER FK → events
user_id     INTEGER FK → users
position    TEXT CHECK (IN ('yes', 'no'))
amount      INTEGER                  -- credits staked
entry_price INTEGER                  -- yes_price or no_price at time of purchase
status      TEXT                     -- OPEN | CLOSED
pnl         INTEGER                  -- set on sell or resolution
created_at  TIMESTAMP
```

### `transactions` — full credit audit log

```
id          SERIAL PK
user_id     INTEGER FK → users
event_id    INTEGER FK → events (nullable)
type        TEXT       -- bet_placed | sell | winnings | loss | daily_bonus | gift
amount      INTEGER
description TEXT
created_at  TIMESTAMP
```

### `price_history` — time-series for chart rendering

```
id          SERIAL PK
event_id    INTEGER FK → events ON DELETE CASCADE
yes_price   INTEGER
no_price    INTEGER
recorded_at TIMESTAMP
```

### `market_notifications` — email subscriber list

```
user_id   INTEGER FK → users  ─┐ composite PK
event_id  INTEGER FK → events  ─┘
notified  BOOLEAN DEFAULT FALSE
```

### `intent_signals` — pre-bet click tracking

```
id         SERIAL PK
event_id   INTEGER FK → events ON DELETE SET NULL (nullable)
action     TEXT       -- e.g. 'click_yes', 'click_no'
ip         TEXT
created_at TIMESTAMP
```

---

## Core mechanics

### Dynamic pricing

Each trade moves the market price. Impact is `floor(amount / 100)` cents, minimum 1¢:

```
buying YES  → yes_price += impact, no_price -= impact
buying NO   → yes_price -= impact, no_price += impact
selling YES → yes_price -= impact, no_price += impact (inverse of buy)
selling NO  → yes_price += impact, no_price -= impact (inverse of buy)
```

Price is clamped to `[1, 99]` to prevent degenerate 0/100 states. Every trade also writes a `price_history` row so chart data accumulates automatically.

### Entry-price-aware payouts

Winners receive `round(stake × 100 / entry_price)`, not a flat 2×:

- A YES bet at 30¢ pays `stake × 100/30 ≈ 3.33×`  
- A YES bet at 70¢ pays `stake × 100/70 ≈ 1.43×`  

This creates genuine risk/reward differentiation and rewards early conviction.

### Selling before resolution

A position can be sold (fully or partially) at any time while the market is open:

```
credits_out = round(sell_amount × current_price / entry_price)
pnl         = credits_out − sell_amount
```

Selling moves the price in the inverse direction of the original buy.

### Atomic daily bonus

The cooldown check is baked into the `UPDATE` predicate — there is no read-then-check-then-write window:

```sql
UPDATE users
SET credits = credits + 200, last_daily_bonus = NOW()
WHERE id = $1
  AND (last_daily_bonus IS NULL OR last_daily_bonus <= NOW() - INTERVAL '24 hours')
RETURNING credits
```

Zero rows updated → cooldown not elapsed. No lock needed.

### Transaction safety

Bet placement, selling, and market resolution each run inside `BEGIN / COMMIT / ROLLBACK`:

```
BEGIN
  SELECT event (verify open, read current price)
  SELECT user credits (verify sufficient balance)
  UPDATE users credits
  INSERT bets
  UPDATE events prices
  INSERT price_history
  INSERT transactions (audit log)
COMMIT
```

A failure at any step rolls back the entire operation. Credit balance and position state are always consistent.

---

## Market lifecycle

```
[created as upcoming]
       │
       │  opens_at passes (scheduler)
       ▼
    [open]  ←── bets accepted here
       │
       │  close_time passes (scheduler)
       ▼
   [closed]  ←── no new bets; admin must resolve within 24 h
       │              │
       │ resolved     │ 24 h elapsed without resolution (scheduler)
       ▼              ▼
  [resolved]      [overdue]  ←── flagged in admin panel
```

---

## Security model

| Concern | Implementation |
|---|---|
| Security headers | `helmet()` — X-Frame-Options, X-Content-Type-Options, HSTS, referrer policy, CSP |
| CORS | Whitelist: `localhost:3000` + `process.env.APP_URL` only |
| Rate limiting | General: 120 req/min; Bets: 20/min; Image upload: 10 per 15 min; Analytics: 30/min |
| Request body | `express.json({ limit: '50kb' })` — rejects oversized payloads |
| Input validation | Title: 5–300 chars; description: ≤1000; analytics action: ≤100 chars, type-checked |
| Image upload | MIME type allowlist (jpeg/png/webp); 2 MB size cap; Cloudinary re-validates on receive |
| SQL injection | All queries use `pg` parameterized statements (`$1, $2, …`) throughout |
| XSS | Frontend escapes all server-rendered strings through `escHtml()` before DOM insertion |
| Error disclosure | Internal errors logged server-side; generic messages returned to client |
| Secrets | All credentials in environment variables; `.env` in `.gitignore`; never committed |

---

## Why a monolith

At the current scale, a monolith has concrete advantages over a distributed system:

- **No network hops** — the scheduler, the API handler, and the database query are in the same process
- **Simpler transactions** — no distributed transaction protocol; `BEGIN/COMMIT` on one connection is sufficient
- **Easier to read** — one file (`server.js`) contains the full server contract; no service discovery or interface layers
- **Deployable as one unit** — Railway runs it as a single Node.js service; no orchestration needed

The natural split points if volume grows are:
1. Extract the scheduler into a separate worker process (e.g. a Railway cron job)
2. Add a WebSocket layer for live price updates instead of 30-second polling
3. Move image processing to a queue if upload volume becomes a bottleneck
