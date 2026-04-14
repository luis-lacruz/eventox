# EventoX

**A binary prediction market platform for Colombian real-world events.**

Users forecast outcomes on politics, economics, and public policy using play-money credits. Markets resolve based on official Colombian government data sources.

---

## Demo

> Screenshots go here — replace these placeholders with actual captures from `localhost:3000`

| Markets View | Placing a Position | Market Detail |
|---|---|---|
| ![Markets](docs/screenshots/markets.png) | ![Bet](docs/screenshots/bet.png) | ![Detail](docs/screenshots/detail.png) |

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
| Auth | JWT + bcrypt *(planned)* |

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

### Events (Markets)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/events` | List all markets |
| `POST` | `/events` | Create a new market |

#### `POST /events` — Request body

```json
{
  "title": "Will Colombia's GDP growth exceed 3%?",
  "description": "Based on DANE official 2026 report",
  "category": "economics",
  "resolution_source": "DANE official publication",
  "close_time": "2027-03-01T00:00:00Z"
}
```

### Positions (Bets)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/bets` | Place a YES or NO position |

#### `POST /bets` — Request body

```json
{
  "event_id": 1,
  "position": "yes",
  "amount": 100
}
```

---

## Roadmap

- [x] Express server + PostgreSQL integration
- [x] Events CRUD API
- [x] Position placement endpoint
- [x] Dark-themed frontend with live market cards
- [ ] User authentication (JWT + bcrypt)
- [ ] User dashboard — track open positions and history
- [ ] Admin panel — create and resolve markets
- [ ] Leaderboard — top predictors by profit
- [ ] Deploy to cloud (Railway / Render)
- [ ] Dynamic pricing engine (order book model)

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
