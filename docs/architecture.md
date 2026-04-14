# EventoX Architecture

## Overview

EventoX follows a classic monolithic web application pattern optimized for a small-scale MVP.

```
┌─────────────────────────────────────────────┐
│                   Client                     │
│          (Vanilla HTML/CSS/JS)               │
│                                              │
│   Market Cards · Ticker · Bet Modal · Toast  │
└──────────────────┬──────────────────────────┘
                   │  HTTP (fetch API)
                   ▼
┌─────────────────────────────────────────────┐
│              Express Server                  │
│                                              │
│   GET  /events      → list markets           │
│   POST /events      → create market          │
│   POST /bets        → place position         │
│   GET  /health      → server status          │
│   GET  /health/db   → database status        │
└──────────────────┬──────────────────────────┘
                   │  SQL (pg driver)
                   ▼
┌─────────────────────────────────────────────┐
│             PostgreSQL                       │
│                                              │
│   events  → market definitions               │
│   bets    → user positions                   │
└─────────────────────────────────────────────┘
```

## Data Model

### events

| Column            | Type      | Notes                         |
|-------------------|-----------|-------------------------------|
| id                | SERIAL PK | Auto-increment                |
| title             | TEXT      | Market question               |
| description       | TEXT      | Context and details           |
| category          | TEXT      | politics / economics / crime  |
| status            | TEXT      | open / closed / resolved      |
| resolution_source | TEXT      | Official data source URL      |
| close_time        | TIMESTAMP | When positions stop accepting |
| created_at        | TIMESTAMP | Auto-set on creation          |

### bets

| Column    | Type      | Notes                      |
|-----------|-----------|----------------------------|
| id        | SERIAL PK | Auto-increment             |
| event_id  | INTEGER   | FK → events.id             |
| position  | TEXT      | "yes" or "no"              |
| amount    | INTEGER   | Credits staked (default 100)|
| created_at| TIMESTAMP | Auto-set on creation       |

## Design Decisions

**Why vanilla HTML/CSS/JS instead of React?**
For an MVP with a single page and limited interactivity, a framework adds complexity without proportional benefit. The frontend is a single `index.html` file that fetches data from the API — fast to iterate, zero build step.

**Why PostgreSQL over SQLite?**
PostgreSQL matches the production deployment target. Starting with it avoids a migration later and provides proper constraint checking (CHECK, REFERENCES) from day one.

**Why monolithic instead of microservices?**
At MVP scale (~60 users), a single Express process handles everything. The code is structured with clear route groupings so it can be split later if needed.

## Planned Extensions

| Feature            | Approach                                   |
|--------------------|--------------------------------------------|
| Authentication     | JWT tokens + bcrypt password hashing       |
| User credits       | `users` table with credit balance tracking |
| Admin panel        | Role-based middleware (`is_admin` flag)     |
| Market resolution  | Admin endpoint to close + settle positions |
| Leaderboard        | Aggregate query on resolved bet profits    |
| Live updates       | WebSocket or Server-Sent Events            |
