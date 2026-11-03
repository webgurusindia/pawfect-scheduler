# Pawfect Scheduler

Appointment booking for a dog grooming business.

- **Customer website** (`/`): browse services and prices, pick a date and time, book, then look up or cancel the booking with its reference and email.
- **Owner dashboard** (`/admin`): password-protected. Day, week and 30-day schedule, confirm / complete / no-show / cancel, reschedule, private notes, phone bookings, services and prices, opening hours, closed dates, and settings.
- **Database**: SQLite (`data/scheduler.db`, created and seeded on first run). Uses Node's built-in `node:sqlite`, so nothing needs compiling.

## Run

Requires Node.js 22.13 or later.

```bash
npm install
ADMIN_PASSWORD='pick-a-strong-one' SESSION_SECRET='long-random-string' npm start
```

Open http://localhost:3000 for the customer site and http://localhost:3000/admin for the dashboard.

| Env var | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Owner login password (default `changeme`, so change it) |
| `SESSION_SECRET` | Signs login cookies. Set it so logins survive restarts |
| `PORT` | Default 3000 |
| `DB_PATH` | Where the SQLite file lives |
| `TZ` | The shop's time zone, e.g. `America/New_York`. Times are wall-clock times in this zone |

## How availability works

Start times are offered every *slot interval* minutes during opening hours. A time is offered only if the whole service fits before closing and fewer than *capacity* appointments overlap it (capacity is the number of groomers or tables). Bookings are re-checked inside a database transaction, so two customers can't take the same slot. Customers must book at least *min notice* hours ahead and no more than *max days ahead*. The owner can override all of these from the dashboard.
