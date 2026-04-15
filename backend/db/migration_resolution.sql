-- Migration: auto-resolution lifecycle (closed / overdue statuses)
-- Run once on Railway: psql $DATABASE_URL -f migration_resolution.sql

ALTER TABLE events ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;

-- Back-fill: any event still marked 'open' whose close_time has already passed
UPDATE events
SET status = 'closed', closed_at = close_time
WHERE status = 'open'
  AND close_time IS NOT NULL
  AND close_time <= NOW();

-- Immediately escalate anything closed for more than 24h
UPDATE events
SET status = 'overdue'
WHERE status = 'closed'
  AND closed_at IS NOT NULL
  AND closed_at <= NOW() - INTERVAL '24 hours';
