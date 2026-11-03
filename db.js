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
    ['Bath & Brush', 'Warm bath, blow-dry, thorough brush-out, ear cleaning and a spritz of cologne.', 60, 99900],
    ['Full Groom', 'Everything in Bath & Brush plus a breed-standard or custom haircut and nail trim.', 120, 199900],
    ['Puppy Intro', 'A gentle first visit for pups under 6 months: short bath, brush and lots of treats.', 45, 79900],
    ['Nail Trim & File', 'Quick clip and smooth file. Walk-in friendly.', 15, 29900],
    ['De-shedding Treatment', 'Special shampoo, conditioner and undercoat removal to cut shedding by up to 80%.', 90, 179900],
    ['Teeth Brushing', 'Enzymatic toothpaste brush for fresher breath.', 15, 24900],
  ].forEach((s, i) => ins.run(...s, i));
}

// ---- Migration v2: richer service details, photos, contact info ----
// Runs once. Safe on databases created by the first version.
const cols = db.prepare('PRAGMA table_info(services)').all().map((c) => c.name);
if (!cols.includes('includes')) db.exec("ALTER TABLE services ADD COLUMN includes TEXT NOT NULL DEFAULT ''");
if (!cols.includes('image')) db.exec("ALTER TABLE services ADD COLUMN image TEXT NOT NULL DEFAULT ''");

const version = Number(db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()?.value || 1);
if (version < 2) {
  // Fill details for the starter services (matched by name, only if still blank),
  // and add the new starter services if a service with that name doesn't exist yet.
  const starter = [
    ['Bath & Brush', 'Warm bath, blow-dry, thorough brush-out, ear cleaning and a spritz of cologne.', 60, 99900,
      '/images/svc-bath.jpg', 'Warm hydro-massage bath\nGentle shampoo matched to coat type\nHand blow-dry & full brush-out\nEar cleaning\nBandana or bow + finishing spritz'],
    ['Full Groom', 'Everything in Bath & Brush plus a breed-standard or custom haircut and nail trim.', 120, 199900,
      '/images/svc-full-groom.jpg', 'Everything in Bath & Brush\nBreed-standard or custom haircut\nFace, feet & sanitary tidy\nNail trim & file\nPaw pad trim'],
    ['Puppy Intro', 'A gentle first visit for pups under 6 months: short bath, brush and lots of treats.', 45, 79900,
      '/images/svc-puppy.jpg', 'Short, positive first bath\nIntroduction to dryer & clippers\nLight face and feet tidy\nNail tip trim\nLots of treats & praise'],
    ['Nail Trim & File', 'Quick clip and smooth file. Walk-in friendly.', 15, 29900,
      '/images/svc-nails.jpg', 'Clip to a healthy length\nSmooth file to prevent snagging\nDew claws included'],
    ['De-shedding Treatment', 'Special shampoo, conditioner and undercoat removal to cut shedding by up to 80%.', 90, 179900,
      '/images/svc-deshed.jpg', 'De-shedding shampoo & conditioner\nHigh-velocity undercoat blow-out\nUndercoat rake & brush-out\nEar cleaning\nGreat for Huskies, Labs, Shepherds & Goldens'],
    ['Teeth Brushing', 'Enzymatic toothpaste brush for fresher breath.', 15, 24900,
      '/images/svc-teeth.jpg', 'Dog-safe enzymatic toothpaste\nGentle finger or soft-brush clean\nFresher breath'],
    ['Spa Day Package', 'Our most pampering visit: full groom plus blueberry facial, paw balm and a conditioning mask.', 150, 299900,
      '/images/svc-spa.jpg', 'Everything in Full Groom\nBlueberry facial (tear-stain friendly)\nDeep-conditioning coat mask\nPaw pad balm\nTeeth brushing'],
    ['Paw & Pad Care', 'A tidy-up for busy paws: pad trim, nail trim and a soothing balm.', 30, 49900,
      '/images/svc-paw.jpg', 'Fur trimmed between pads\nNail trim & file\nMoisturising paw balm'],
    ['Flea & Tick Bath', 'Medicated bath with a vet-recommended shampoo and a careful comb-through.', 60, 129900,
      '/images/svc-flea.jpg', 'Vet-recommended medicated shampoo\nFine-tooth flea comb-through\nBlow-dry & brush\nAdvice on ongoing prevention'],
  ];
  const find = db.prepare('SELECT * FROM services WHERE name = ?');
  const fill = db.prepare("UPDATE services SET includes = CASE WHEN includes = '' THEN ? ELSE includes END, image = CASE WHEN image = '' THEN ? ELSE image END WHERE id = ?");
  const add = db.prepare('INSERT INTO services (name, description, duration_min, price_cents, image, includes, sort_order) VALUES (?,?,?,?,?,?,?)');
  starter.forEach(([name, desc, dur, price, img, inc], i) => {
    const s = find.get(name);
    if (s) fill.run(inc, img, s.id); else add.run(name, desc, dur, price, img, inc, i);
  });
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  ins.run('phone', ''); ins.run('email', ''); ins.run('address', '');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '2')").run();
}

// ---- Migration v3: prices in Indian Rupees (stored in paise) ----
// Starter services still at their original dollar price are moved to the INR starter price.
// Prices the owner has already changed are left alone.
if (Number(db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()?.value || 1) < 3) {
  const toInr = {
    'Bath & Brush': [4500, 99900],
    'Full Groom': [8500, 199900],
    'Puppy Intro': [3500, 79900],
    'Nail Trim & File': [1500, 29900],
    'De-shedding Treatment': [7000, 179900],
    'Teeth Brushing': [1200, 24900],
    'Spa Day Package': [11000, 299900],
    'Paw & Pad Care': [2500, 49900],
    'Flea & Tick Bath': [5500, 129900],
  };
  const upd = db.prepare('UPDATE services SET price_cents = ? WHERE name = ? AND price_cents = ?');
  const updAppts = db.prepare(
    'UPDATE appointments SET price_cents = ? WHERE price_cents = ? AND service_id IN (SELECT id FROM services WHERE name = ?)');
  for (const [name, [oldUsd, inr]] of Object.entries(toInr)) { upd.run(inr, name, oldUsd); updAppts.run(inr, oldUsd, name); }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '3')").run();
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

module.exports = { db, getSettings };
