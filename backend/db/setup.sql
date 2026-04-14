-- EventoX Database Setup
-- Run: psql eventox < db/setup.sql

-- Markets table
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'politics',
  status TEXT DEFAULT 'open',
  resolution_source TEXT,
  close_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Positions table
CREATE TABLE IF NOT EXISTS bets (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  position TEXT NOT NULL CHECK (position IN ('yes', 'no')),
  amount INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Seed data: sample Colombian markets
INSERT INTO events (title, description, category, resolution_source, close_time)
VALUES
  (
    '¿Será Gustavo Petro declarado oficialmente ganador de la Elección Presidencial de Colombia 2026?',
    'Resolución basada en resultados oficiales certificados.',
    'politics',
    'Registraduría Nacional del Estado Civil',
    '2026-05-31 06:00:00'
  ),
  (
    '¿Superará el crecimiento real del PIB de Colombia el 3.0% para el año 2026 según el DANE?',
    'Basado en la publicación anual oficial del DANE.',
    'economics',
    'DANE publicación oficial',
    '2027-03-01 00:00:00'
  ),
  (
    '¿Se mantendrá la inflación por encima del 5% para el mes de junio 2026?',
    'Basado en el reporte mensual del IPC publicado por el DANE.',
    'economics',
    'DANE reporte IPC mensual',
    '2026-07-05 00:00:00'
  );
