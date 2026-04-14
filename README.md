# EventoX

**A binary prediction market platform for Colombian real-world events.**

Users forecast outcomes on politics, economics, and public policy using play-money credits. Markets resolve based on official Colombian government data sources.

---

## Demo

<img src="docs/screenshots/markets-v2.png" alt="EventoX Markets View" width="100%">

---

## How It Works

1. **Admin creates a market** — a binary Yes/No question tied to a real-world event  
2. **Users take positions** — stake credits on YES or NO  
3. **Event occurs** — market resolves based on official data (e.g., DANE, Registraduría Nacional)  
4. **Payouts settle** — correct predictions earn credits; incorrect positions lose their stake  

### Example Market

> *"Will Colombia's real GDP growth for 2026 exceed 3.0% as reported by DANE?"*  
> Resolution source: DANE official annual publication  
> Close time: 1 hour before report publication  

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Database | PostgreSQL |
| Frontend | Vanilla HTML / CSS / JS |
| Auth | JWT + bcrypt |

---

## Project Structure

```
eventox/
├── backend/
│   ├── server.js            # Express API server
│   ├── public/
│   │   └── index.html       # Single-page frontend
│   ├── package.json
│   ├── .env                  # Local env vars (not committed)
│   └── .env.example          # Template for env setup
├── docs/
│   ├── screenshots/          # UI captures for README
│   └── architecture.md       # System design notes
├── .gitignore
├── LICENSE
└── README.md
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [PostgreSQL](https://www.postgresql.org/) 14+

### 1. Clone the repo

```bash
git clone https://github.com/luis-lacruz/eventox.git
cd eventox
```

### 2. Install dependencies

```bash
cd backend
npm install
```

### 3. Set up the database

```bash
# Create the database
createdb eventox

# Connect and create tables
psql eventox
```

```sql
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'politics',
  status TEXT DEFAULT 'open',
  resolution_source TEXT,
  close_time TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE bets (
  id SERIAL PRIMARY KEY,
  event_id INTEGER REFERENCES events(id),
  position TEXT NOT NULL CHECK (position IN ('yes', 'no')),
  amount INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env with your PostgreSQL connection string
```

### 5. Start the server

```bash
node server.js
# → Server running on port 3000
```

Visit **http://localhost:3000**

---

## API Reference

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server status check |
| `GET` | `/health/db` | Database connection check |
| `GET` | `/stats` | Market and position counts |

### Authentication

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | No | Create account → returns JWT |
| `POST` | `/auth/login` | No | Login → returns JWT |
| `GET` | `/auth/me` | Yes | Current user info |

### Events (Markets)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/events` | No | List all markets |
| `POST` | `/events` | Admin | Create a new market |
| `POST` | `/events/:id/resolve` | Admin | Resolve market as YES/NO, pays winners |

### Positions (Bets)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/bets` | Yes | Place a YES or NO position |
| `GET` | `/bets/mine` | Yes | List current user's positions with results |

### Credits

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/credits/daily` | Yes | Claim 200 free credits every 24h |
| `POST` | `/admin/gift-credits` | Admin | Gift credits to a user by username |

### Leaderboard

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/leaderboard` | No | Top 20 users by credits |

## Roadmap

- [x] Express server + PostgreSQL integration
- [x] Events CRUD API
- [x] Position placement endpoint
- [x] Dark-themed frontend with live market cards
- [x] User authentication (JWT + bcrypt)
- [x] User dashboard — track open positions and history
- [x] Admin panel — create and resolve markets
- [x] Leaderboard — top predictors by profit
- [x] Daily login bonus + admin credit gifting
- [x] Win/loss history with performance stats
- [ ] Deploy to cloud (Railway / Render)
- [ ] Dynamic pricing engine (order book model)
- [ ] Rate limiting and input sanitization

---

## Context

EventoX is a binary prediction market — not a betting platform. It's designed as a civic engagement tool where users forecast real-world Colombian events using play money. All market resolutions are tied to official, publicly verifiable government data sources.

Built as a hands-on full-stack learning project and functional MVP targeting ~60 initial users.

---

## License

MIT

---

## Author

**Luis S. Lacruz**  
[GitHub](https://github.com/luis-lacruz) · [LinkedIn](https://linkedin.com/in/luis-lacruz)
