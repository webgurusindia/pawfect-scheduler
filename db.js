// Database layer.
//  - DATABASE_URL (or POSTGRES_URL) set  -> PostgreSQL  (used on Vercel, e.g. Neon)
//  - otherwise                           -> SQLite file (local use; Node's built-in node:sqlite)
//
// All SQL in the app is written once, with `?` placeholders, in syntax both databases accept.
// The API is async either way:  query / get / run(sql, params)  and  tx(async (q) => ...).
const path = require('path');
const fs = require('fs');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
// On Vercel the file system is read-only and wiped between requests, so SQLite can't be used there.
const dialect = PG_URL ? 'postgres' : process.env.VERCEL ? 'none' : 'sqlite';

const img = (id, w = 800, h = 600) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&q=72&auto=format`;

// Starter services (prices in paise: 99900 = ₹999). Photos are from Unsplash.
const STARTER_SERVICES = [
  ['Bath & Brush', 'Warm bath, blow-dry, thorough brush-out, ear cleaning and a spritz of cologne.', 60, 99900,
    img('1544568100-847a948585b9'), 'Warm hydro-massage bath\nGentle shampoo matched to coat type\nHand blow-dry & full brush-out\nEar cleaning\nBandana or bow + finishing spritz'],
  ['Full Groom', 'Everything in Bath & Brush plus a breed-standard or custom haircut and nail trim.', 120, 199900,
    img('1625316708582-7c38734be31d'), 'Everything in Bath & Brush\nBreed-standard or custom haircut\nFace, feet & sanitary tidy\nNail trim & file\nPaw pad trim'],
  ['Puppy Intro', 'A gentle first visit for pups under 6 months: short bath, brush and lots of treats.', 45, 79900,
    img('1507146426996-ef05306b995a'), 'Short, positive first bath\nIntroduction to dryer & clippers\nLight face and feet tidy\nNail tip trim\nLots of treats & praise'],
  ['Nail Trim & File', 'Quick clip and smooth file. Walk-in friendly.', 15, 29900,
    img('1561037404-61cd46aa615b'), 'Clip to a healthy length\nSmooth file to prevent snagging\nDew claws included'],
  ['De-shedding Treatment', 'Special shampoo, conditioner and undercoat removal to cut shedding by up to 80%.', 90, 179900,
    img('1587300003388-59208cc962cb'), 'De-shedding shampoo & conditioner\nHigh-velocity undercoat blow-out\nUndercoat rake & brush-out\nEar cleaning\nGreat for Huskies, Labs, Shepherds & Goldens'],
  ['Teeth Brushing', 'Enzymatic toothpaste brush for fresher breath.', 15, 24900,
    img('1543466835-00a7907e9de1'), 'Dog-safe enzymatic toothpaste\nGentle finger or soft-brush clean\nFresher breath'],
  ['Spa Day Package', 'Our most pampering visit: full groom plus blueberry facial, paw balm and a conditioning mask.', 150, 299900,
    img('1552053831-71594a27632d'), 'Everything in Full Groom\nBlueberry facial (tear-stain friendly)\nDeep-conditioning coat mask\nPaw pad balm\nTeeth brushing'],
  ['Paw & Pad Care', 'A tidy-up for busy paws: pad trim, nail trim and a soothing balm.', 30, 49900,
    img('1583511655857-d19b40a7a54e'), 'Fur trimmed between pads\nNail trim & file\nMoisturising paw balm'],
  ['Flea & Tick Bath', 'Medicated bath with a vet-recommended shampoo and a careful comb-through.', 60, 129900,
    img('1588943211346-0908a1fb0b01'), 'Vet-recommended medicated shampoo\nFine-tooth flea comb-through\nBlow-dry & brush\nAdvice on ongoing prevention'],
];
const SCHEMA_VERSION = 4;

const DEFAULT_SETTINGS = {
  business_name: 'Pawfect Grooming',
  slot_interval_min: '30',   // how often start times are offered
  capacity: '1',             // how many dogs can be groomed at the same time
  min_notice_hours: '2',     // earliest a customer can book from now
  max_days_ahead: '60',      // how far out customers can book
  phone: '', email: '', address: '',
};

function schema(pg) {
  const id = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const now = pg ? "(to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))" : "(datetime('now'))";
  return [
    `CREATE TABLE IF NOT EXISTS services (
      id            ${id},
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      duration_min  INTEGER NOT NULL,
      price_cents   INTEGER NOT NULL,          -- paise (1/100 rupee)
      active        INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      includes      TEXT NOT NULL DEFAULT '',  -- one item per line
      image         TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS business_hours (
      weekday     INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
      open_time   TEXT NOT NULL DEFAULT '09:00',
      close_time  TEXT NOT NULL DEFAULT '17:00',
      closed      INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS blocked_dates (
      date    TEXT PRIMARY KEY,                  -- YYYY-MM-DD
      reason  TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS appointments (
      id              ${id},
      ref             TEXT NOT NULL UNIQUE,
      service_id      INTEGER NOT NULL REFERENCES services(id),
      date            TEXT NOT NULL,             -- YYYY-MM-DD (shop local time)
      start_min       INTEGER NOT NULL,          -- minutes after midnight
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
      created_at      TEXT NOT NULL DEFAULT ${now}
    )`,
    'CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date, status)',
    `CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    )`,
  ];
}

// ---------- drivers ----------
let driver;
if (dialect === 'postgres') {
  const pg = require('pg');
  pg.types.setTypeParser(20, Number);   // COUNT/SUM come back as numbers, not strings
  const pool = new pg.Pool({
    connectionString: PG_URL,
    max: 3,
    ssl: /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false },
  });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const wrap = (c) => ({
    query: async (sql, p = []) => (await c.query(toPg(sql), p)).rows,
    get: async (sql, p = []) => (await c.query(toPg(sql), p)).rows[0],
    run: async (sql, p = []) => { const r = await c.query(toPg(sql), p); return { changes: r.rowCount, row: r.rows[0] }; },
  });
  driver = {
    ...wrap(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(7421)'); // one writer at a time: no double bookings
        const r = await fn(wrap(c));
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
  };
} else if (dialect === 'none') {
  // Keep the site up (pages still load) and give a clear message instead of crashing.
  const fail = async () => {
    const e = new Error('The booking database is not connected yet. Please try again later.');
    e.status = 503; e.expose = true;
    console.error('No database configured: connect Neon Postgres in Vercel → Storage (sets DATABASE_URL), then redeploy.');
    throw e;
  };
  driver = { query: fail, get: fail, run: fail, tx: fail };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'scheduler.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // node:sqlite is synchronous, so a transaction body that only awaits these calls
  // can't be interleaved with other requests.
  const q = {
    query: async (sql, p = []) => db.prepare(sql).all(...p),
    get: async (sql, p = []) => db.prepare(sql).get(...p),
    run: async (sql, p = []) => {
      const st = db.prepare(sql);
      if (/\bRETURNING\b/i.test(sql)) { const row = st.get(...p); return { changes: row ? 1 : 0, row }; }
      return { changes: Number(st.run(...p).changes) };
    },
  };
  driver = {
    ...q,
    exec: (sql) => db.exec(sql),
    async tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await fn(q); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

// ---------- setup / migrations ----------
async function init() {
  await driver.tx(async (q) => {
    for (const stmt of schema(dialect === 'postgres')) await q.run(stmt);

    if (dialect === 'sqlite') {
      // Databases created by the first version lack these columns.
      const cols = (await q.query('PRAGMA table_info(services)')).map((c) => c.name);
      if (!cols.includes('includes')) await q.run("ALTER TABLE services ADD COLUMN includes TEXT NOT NULL DEFAULT ''");
      if (!cols.includes('image')) await q.run("ALTER TABLE services ADD COLUMN image TEXT NOT NULL DEFAULT ''");
    }

    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
    }

    if ((await q.get('SELECT COUNT(*) AS n FROM business_hours')).n === 0) {
      const hours = [[0, '10:00', '15:00', 1], [1, '09:00', '17:00', 0], [2, '09:00', '17:00', 0], [3, '09:00', '17:00', 0],
        [4, '09:00', '17:00', 0], [5, '09:00', '17:00', 0], [6, '09:00', '14:00', 0]];
      for (const h of hours) await q.run('INSERT INTO business_hours (weekday, open_time, close_time, closed) VALUES (?,?,?,?)', h);
    }

    const freshServices = (await q.get('SELECT COUNT(*) AS n FROM services')).n === 0;
    const version = Number((await q.get("SELECT value FROM settings WHERE key = 'schema_version'"))?.value || 1);

    if (freshServices) {
      for (const [i, [name, desc, dur, price, image, includes]] of STARTER_SERVICES.entries()) {
        await q.run('INSERT INTO services (name, description, duration_min, price_cents, image, includes, sort_order) VALUES (?,?,?,?,?,?,?)',
          [name, desc, dur, price, image, includes, i]);
      }
    } else if (version < SCHEMA_VERSION) {
      await upgradeOldDatabase(q, version);
    }
    await q.run("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(SCHEMA_VERSION)]);
  });
}

// Brings databases from earlier versions of this app up to date. Only touches values the
// owner hasn't changed (matched by the original starter name/price/photo).
async function upgradeOldDatabase(q, version) {
  const starterByName = Object.fromEntries(STARTER_SERVICES.map((s) => [s[0], s]));
  const oldUsd = { 'Bath & Brush': 4500, 'Full Groom': 8500, 'Puppy Intro': 3500, 'Nail Trim & File': 1500,
    'De-shedding Treatment': 7000, 'Teeth Brushing': 1200, 'Spa Day Package': 11000, 'Paw & Pad Care': 2500, 'Flea & Tick Bath': 5500 };
  const oldLocalImage = { 'Bath & Brush': 'svc-bath', 'Full Groom': 'svc-full-groom', 'Puppy Intro': 'svc-puppy',
    'Nail Trim & File': 'svc-nails', 'De-shedding Treatment': 'svc-deshed', 'Teeth Brushing': 'svc-teeth',
    'Spa Day Package': 'svc-spa', 'Paw & Pad Care': 'svc-paw', 'Flea & Tick Bath': 'svc-flea' };

  if (version < 2) { // v2: service details + new starter services
    for (const [i, [name, desc, dur, price, image, includes]] of STARTER_SERVICES.entries()) {
      const s = await q.get('SELECT id FROM services WHERE name = ?', [name]);
      if (s) {
        await q.run("UPDATE services SET includes = CASE WHEN includes = '' THEN ? ELSE includes END, image = CASE WHEN image = '' THEN ? ELSE image END WHERE id = ?",
          [includes, image, s.id]);
      } else {
        await q.run('INSERT INTO services (name, description, duration_min, price_cents, image, includes, sort_order) VALUES (?,?,?,?,?,?,?)',
          [name, desc, dur, price, image, includes, i]);
      }
    }
  }
  if (version < 3) { // v3: dollars -> rupees
    for (const [name, usd] of Object.entries(oldUsd)) {
      const inr = starterByName[name][3];
      await q.run('UPDATE services SET price_cents = ? WHERE name = ? AND price_cents = ?', [inr, name, usd]);
      await q.run('UPDATE appointments SET price_cents = ? WHERE price_cents = ? AND service_id IN (SELECT id FROM services WHERE name = ?)',
        [inr, usd, name]);
    }
  }
  if (version < 4) { // v4: bundled /images/*.jpg photos -> Unsplash links
    for (const [name, file] of Object.entries(oldLocalImage)) {
      await q.run('UPDATE services SET image = ? WHERE image = ?', [starterByName[name][4], `/images/${file}.jpg`]);
    }
  }
}

let readyPromise;
const ready = () => (readyPromise ||= init().catch((e) => { readyPromise = null; throw e; }));

async function getSettings(q = driver) {
  const out = {};
  for (const r of await q.query('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

module.exports = { db: driver, dialect, ready, getSettings };
