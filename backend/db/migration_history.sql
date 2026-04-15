-- Migration: add price_history and transactions tables
-- Run once on Railway: psql $DATABASE_URL -f migration_history.sql

CREATE TABLE IF NOT EXISTS price_history (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER REFERENCES events(id),
  yes_price   INTEGER NOT NULL,
  no_price    INTEGER NOT NULL,
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  event_id    INTEGER REFERENCES events(id),
  type        TEXT NOT NULL,   -- bet_placed | winnings | sell | loss
  amount      INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);
