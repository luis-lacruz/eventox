-- Upcoming Markets Migration
-- Adds opens_at and watch_count to support teaser/upcoming market cards.
-- The existing `status` TEXT column already accepts any value,
-- so 'upcoming' is a valid new status with no schema change needed there.

ALTER TABLE events ADD COLUMN IF NOT EXISTS opens_at TIMESTAMP;
ALTER TABLE events ADD COLUMN IF NOT EXISTS watch_count INTEGER DEFAULT 0;

-- Backfill NULL watch_count on existing rows
UPDATE events SET watch_count = 0 WHERE watch_count IS NULL;
