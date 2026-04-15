-- EventoX Database Setup
-- Run: psql eventox < db/setup.sql

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  credits INTEGER DEFAULT 1000,
  is_admin BOOLEAN DEFAULT false,
  last_bonus_claim TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'politics',
  status TEXT DEFAULT 'open',
  outcome TEXT,
  resolved BOOLEAN DEFAULT false,
  yes_price INTEGER DEFAULT 50,
  no_price INTEGER DEFAULT 50,
  resolution_source TEXT,
  close_time TIMESTAMP,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE bets (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  user_id INTEGER REFERENCES users(id),
  position TEXT NOT NULL CHECK (position IN ('yes', 'no')),
  amount INTEGER NOT NULL DEFAULT 100,
  entry_price INTEGER NOT NULL DEFAULT 50,  -- market price (¢) at time of purchase
  status TEXT NOT NULL DEFAULT 'OPEN',      -- OPEN | CLOSED
  pnl INTEGER NOT NULL DEFAULT 0,           -- realised profit/loss in credits (set on close)
  created_at TIMESTAMP DEFAULT NOW()
);