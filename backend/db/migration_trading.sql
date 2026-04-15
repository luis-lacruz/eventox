-- Migration: add tradable-positions fields to bets table
-- Run once on Railway: psql $DATABASE_URL -f migration_trading.sql

ALTER TABLE bets ADD COLUMN IF NOT EXISTS entry_price INTEGER NOT NULL DEFAULT 50;
ALTER TABLE bets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE bets ADD COLUMN IF NOT EXISTS pnl INTEGER NOT NULL DEFAULT 0;

-- Back-fill existing bets: treat them as open positions bought at 50¢
UPDATE bets SET entry_price = 50, status = 'OPEN', pnl = 0
  WHERE status IS NULL OR status = '';
