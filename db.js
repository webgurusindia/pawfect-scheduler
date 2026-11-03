// Database layer: SQLite (built into Node 22+ as node:sqlite, no native build needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'scheduler.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  duration_min  INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS business_hours (
  weekday     INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  open_time   TEXT NOT NULL DEFAULT '09:00',
  close_time  TEXT NOT NULL DEFAULT '17:00',
  closed      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  date    TEXT PRIMARY KEY,           -- YYYY-MM-DD
  reason  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS appointments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT NOT NULL UNIQUE,
  service_id      INTEGER NOT NULL REFERENCES services(id),
  date            TEXT NOT NULL,      -- YYYY-MM-DD (shop local time)
  start_min       INTEGER NOT NULL,   -- minutes after midnight
  end_min         INTEGER NOT NULL,
  customer_name   TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT NOT NULL,
  dog_name        TEXT NOT NULL,
  breed           TEXT NOT NULL DEFAULT '',
  dog_size        TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  admin_notes     TEXT NOT NULL DEFAULT '',
  price_cents     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked','confirmed','completed','cancelled','no_show')),
  source          TEXT NOT NULL DEFAULT 'online',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, status);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`);

// ---- Seed defaults on first run ----
const defaults = {
  business_name: 'Pawfect Grooming',
  slot_interval_min: '30',   // how often start times are offered
  capacity: '1',             // how many dogs can be groomed at the same time
  min_notice_hours: '2',     // earliest a customer can book from now
  max_days_ahead: '60',      // how far out customers can book
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

if (db.prepare('SELECT COUNT(*) AS n FROM business_hours').get().n === 0) {
  const ins = db.prepare('INSERT INTO business_hours (weekday, open_time, close_time, closed) VALUES (?, ?, ?, ?)');
  ins.run(0, '10:00', '15:00', 1);       // Sunday closed
  for (let d = 1; d <= 5; d++) ins.run(d, '09:00', '17:00', 0);
  ins.run(6, '09:00', '14:00', 0);       // Saturday short day
}

if (db.prepare('SELECT COUNT(*) AS n FROM services').get().n === 0) {
  const ins = db.prepare('INSERT INTO services (name, description, duration_min, price_cents, sort_order) VALUES (?, ?, ?, ?, ?)');
  [
    ['Bath & Brush', 'Warm bath, blow-dry, thorough brush-out, ear cleaning and a spritz of cologne.', 60, 4500],
    ['Full Groom', 'Everything in Bath & Brush plus a breed-standard or custom haircut and nail trim.', 120, 8500],
    ['Puppy Intro', 'A gentle first visit for pups under 6 months: short bath, brush and lots of treats.', 45, 3500],
    ['Nail Trim & File', 'Quick clip and smooth file. Walk-in friendly.', 15, 1500],
    ['De-shedding Treatment', 'Special shampoo, conditioner and undercoat removal to cut shedding by up to 80%.', 90, 7000],
    ['Teeth Brushing', 'Enzymatic toothpaste brush for fresher breath.', 15, 1200],
  ].forEach((s, i) => ins.run(...s, i));
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

module.exports = { db, getSettings };
