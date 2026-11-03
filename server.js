const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, ready, getSettings } = require('./db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SHOP_TZ = process.env.SHOP_TZ || 'Asia/Kolkata';   // all dates/times are the shop's local time
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set — using default "changeme". Set it before going live.');
if (process.env.VERCEL && !process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET not set — owner logins will randomly expire on Vercel.');

// ---------- helpers ----------
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Date strings (YYYY-MM-DD) are handled as calendar dates, independent of the server's time zone.
const weekdayOf = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function shopNow() { // { date: 'YYYY-MM-DD', min: minutes since midnight } in the shop's time zone
  const p = Object.fromEntries(tzFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

function makeRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return s;
}

/**
 * Start times (in minutes) open for a service on a date.
 * q                  - db or transaction handle
 * opts.ignoreNotice  - admin bookings skip the min-notice / max-days rules
 * opts.excludeId     - ignore an appointment (when rescheduling it)
 */
async function availableSlots(q, date, durationMin, opts = {}) {
  const settings = await getSettings(q);
  const interval = Number(settings.slot_interval_min) || 30;
  const capacity = Number(settings.capacity) || 1;

  if (await q.get('SELECT 1 AS x FROM blocked_dates WHERE date = ?', [date])) return [];
  const hours = await q.get('SELECT * FROM business_hours WHERE weekday = ?', [weekdayOf(date)]);
  if (!hours || hours.closed) return [];

  let earliest = -1;
  if (!opts.ignoreNotice) {
    const now = shopNow();
    if (date < now.date || date > addDays(now.date, Number(settings.max_days_ahead || 60))) return [];
    const total = now.min + Math.round(Number(settings.min_notice_hours || 0) * 60);
    const cutoffDate = addDays(now.date, Math.floor(total / 1440));
    if (date < cutoffDate) return [];
    if (date === cutoffDate) earliest = total % 1440;
  }

  const appts = await q.query(
    `SELECT start_min, end_min FROM appointments
     WHERE date = ? AND status NOT IN ('cancelled','no_show') AND id != ?`, [date, opts.excludeId || -1]);

  const open = toMin(hours.open_time), close = toMin(hours.close_time);
  const slots = [];
  for (let t = open; t + durationMin <= close; t += interval) {
    if (t < earliest) continue;
    const overlapping = appts.filter((a) => a.start_min < t + durationMin && a.end_min > t).length;
    if (overlapping < capacity) slots.push(t);
  }
  return slots;
}

const apptView = (a) => ({ ...a, start_time: toHHMM(a.start_min), end_time: toHHMM(a.end_min) });

function validateCustomer(body) {
  const c = {
    customer_name: str(body.customer_name, 100),
    email: str(body.email, 120).toLowerCase(),
    phone: str(body.phone, 30),
    dog_name: str(body.dog_name, 60),
    breed: str(body.breed, 60),
    dog_size: str(body.dog_size, 20),
    notes: str(body.notes, 1000),
  };
  if (!c.customer_name) throw new HttpError(400, 'Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new HttpError(400, 'Please enter a valid email.');
  if (c.phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Please enter a valid phone number.');
  if (!c.dog_name) throw new HttpError(400, "Please enter your dog's name.");
  return c;
}

async function getAppointment(q, id) {
  const a = await q.get(
    `SELECT a.*, s.name AS service_name, s.duration_min FROM appointments a
     JOIN services s ON s.id = a.service_id WHERE a.id = ?`, [id]);
  return a && apptView(a);
}

async function createAppointment(body, { admin = false } = {}) {
  const service = await db.get('SELECT * FROM services WHERE id = ?', [Number(body.service_id) || 0]);
  if (!service || (!admin && !service.active)) throw new HttpError(400, 'Please choose a service.');
  if (!isDate(body.date) || !isTime(body.time)) throw new HttpError(400, 'Please choose a date and time.');
  const c = validateCustomer(body);
  const start = toMin(body.time);

  return db.tx(async (q) => {
    // Re-check availability inside the transaction so two people can't grab the same slot.
    if (!admin || !body.force) {
      const slots = await availableSlots(q, body.date, service.duration_min, { ignoreNotice: admin });
      if (!slots.includes(start)) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another.');
    }
    const r = await q.run(
      `INSERT INTO appointments (ref, service_id, date, start_min, end_min, customer_name, email, phone,
         dog_name, breed, dog_size, notes, price_cents, status, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [makeRef(), service.id, body.date, start, start + service.duration_min, c.customer_name, c.email, c.phone,
        c.dog_name, c.breed, c.dog_size, c.notes, service.price_cents, admin ? 'confirmed' : 'booked', admin ? 'admin' : 'online']);
    return getAppointment(q, r.row.id);
  });
}

// Make sure tables exist before any API call (first request after a cold start on Vercel).
app.use('/api', wrap(async (req, res, next) => { await ready(); next(); }));

// ---------- public API ----------
app.get('/api/config', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ business_name: s.business_name, max_days_ahead: Number(s.max_days_ahead), today: shopNow().date,
    phone: s.phone || '', email: s.email || '', address: s.address || '',
    hours: await db.query('SELECT * FROM business_hours ORDER BY weekday') });
}));

app.get('/api/services', wrap(async (req, res) => {
  res.json(await db.query('SELECT id, name, description, duration_min, price_cents, includes, image FROM services WHERE active = 1 ORDER BY sort_order, id'));
}));

app.get('/api/availability', wrap(async (req, res) => {
  const service = await db.get('SELECT * FROM services WHERE id = ? AND active = 1', [Number(req.query.service_id) || 0]);
  if (!service) throw new HttpError(400, 'Unknown service');
  if (!isDate(req.query.date)) throw new HttpError(400, 'Invalid date');
  res.json({ date: req.query.date, slots: (await availableSlots(db, req.query.date, service.duration_min)).map(toHHMM) });
}));

app.post('/api/appointments', wrap(async (req, res) => {
  const a = await createAppointment(req.body);
  res.status(201).json({ ref: a.ref, date: a.date, start_time: a.start_time, service_name: a.service_name,
    dog_name: a.dog_name, price_cents: a.price_cents });
}));

// Customers look up / cancel with booking ref + email (acts as a lightweight password).
async function findCustomerAppt(ref, email) {
  const a = await db.get(
    `SELECT a.*, s.name AS service_name FROM appointments a JOIN services s ON s.id = a.service_id
     WHERE a.ref = ? AND a.email = ?`, [str(ref, 12).toUpperCase(), str(email, 120).toLowerCase()]);
  if (!a) throw new HttpError(404, 'No booking found with that reference and email.');
  return a;
}
const publicAppt = (a) => ({ ref: a.ref, date: a.date, start_time: toHHMM(a.start_min), service_name: a.service_name,
  dog_name: a.dog_name, status: a.status, price_cents: a.price_cents });

app.post('/api/appointments/lookup', wrap(async (req, res) => {
  res.json(publicAppt(await findCustomerAppt(req.body.ref, req.body.email)));
}));

app.post('/api/appointments/cancel', wrap(async (req, res) => {
  const a = await findCustomerAppt(req.body.ref, req.body.email);
  if (!['booked', 'confirmed'].includes(a.status)) throw new HttpError(400, 'This booking can no longer be cancelled online.');
  await db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [a.id]);
  res.json(publicAppt({ ...a, status: 'cancelled' }));
}));

// ---------- admin auth (signed cookie) ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const makeToken = () => { const exp = Date.now() + 12 * 3600e3; return `${exp}.${sign(String(exp))}`; };
function validToken(tok) {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const requireAdmin = (req, res, next) => (validToken(getCookie(req, 'admin')) ? next() : res.status(401).json({ error: 'Not signed in' }));

const loginAttempts = new Map(); // ip -> {count, until}  (per server instance)
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (rec.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const given = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const actual = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, actual)) {
    rec.count++;
    if (rec.count >= 5) { rec.until = Date.now() + 5 * 60e3; rec.count = 0; }
    loginAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Incorrect password' });
  }
  loginAttempts.delete(ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

const admin = express.Router();
admin.use(requireAdmin);
app.use('/api/admin', admin);

admin.get('/me', (req, res) => res.json({ ok: true }));

// Appointments
admin.get('/appointments', wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : shopNow().date;
  const to = isDate(req.query.to) ? req.query.to : from;
  const params = [from, to];
  let sql = `SELECT a.*, s.name AS service_name FROM appointments a JOIN services s ON s.id = a.service_id
             WHERE a.date BETWEEN ? AND ?`;
  if (req.query.status) { sql += ' AND a.status = ?'; params.push(String(req.query.status)); }
  if (req.query.q) {
    sql += ' AND (LOWER(a.customer_name) LIKE ? OR LOWER(a.dog_name) LIKE ? OR LOWER(a.email) LIKE ? OR a.phone LIKE ? OR LOWER(a.ref) LIKE ?)';
    const q = `%${str(req.query.q, 60).toLowerCase()}%`; params.push(q, q, q, q, q);
  }
  sql += ' ORDER BY a.date, a.start_min';
  res.json((await db.query(sql, params)).map(apptView));
}));

admin.post('/appointments', wrap(async (req, res) => res.status(201).json(await createAppointment(req.body, { admin: true }))));

admin.patch('/appointments/:id', wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const b = req.body;
  const updated = await db.tx(async (q) => {
    const a = await getAppointment(q, id);
    if (!a) throw new HttpError(404, 'Not found');
    if (b.status !== undefined) {
      if (!['booked', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(b.status)) throw new HttpError(400, 'Bad status');
      await q.run('UPDATE appointments SET status = ? WHERE id = ?', [b.status, id]);
    }
    if (b.admin_notes !== undefined) await q.run('UPDATE appointments SET admin_notes = ? WHERE id = ?', [str(b.admin_notes, 2000), id]);
    if (b.date !== undefined || b.time !== undefined) { // reschedule
      const date = b.date ?? a.date, time = b.time ?? a.start_time;
      if (!isDate(date) || !isTime(time)) throw new HttpError(400, 'Invalid date/time');
      const start = toMin(time);
      if (!b.force && !(await availableSlots(q, date, a.duration_min, { ignoreNotice: true, excludeId: id })).includes(start)) {
        throw new HttpError(409, 'That time is not available (outside hours or overlapping). Tick "override" to force it.');
      }
      await q.run('UPDATE appointments SET date = ?, start_min = ?, end_min = ? WHERE id = ?', [date, start, start + a.duration_min, id]);
    }
    return getAppointment(q, id);
  });
  res.json(updated);
}));

admin.get('/slots', wrap(async (req, res) => {
  const service = await db.get('SELECT * FROM services WHERE id = ?', [Number(req.query.service_id) || 0]);
  if (!service || !isDate(req.query.date)) throw new HttpError(400, 'Bad request');
  const slots = await availableSlots(db, req.query.date, service.duration_min, { ignoreNotice: true, excludeId: Number(req.query.exclude) || 0 });
  res.json(slots.map(toHHMM));
}));

admin.get('/stats', wrap(async (req, res) => {
  const today = shopNow().date;
  const weekStart = addDays(today, -weekdayOf(today)), weekEnd = addDays(weekStart, 6);
  const active = "status NOT IN ('cancelled','no_show')";
  res.json({
    today: (await db.get(`SELECT COUNT(*) AS n FROM appointments WHERE date = ? AND ${active}`, [today])).n,
    week: await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(price_cents), 0) AS rev FROM appointments WHERE date BETWEEN ? AND ? AND ${active}`, [weekStart, weekEnd]),
    pending: (await db.get("SELECT COUNT(*) AS n FROM appointments WHERE status = 'booked' AND date >= ?", [today])).n,
  });
}));

// Services
admin.get('/services', wrap(async (req, res) => res.json(await db.query('SELECT * FROM services ORDER BY sort_order, id'))));
function serviceFields(b) {
  const s = { name: str(b.name, 80), description: str(b.description, 500), duration_min: Number(b.duration_min),
    price_cents: Math.round(Number(b.price_cents)), active: b.active === false || b.active === 0 ? 0 : 1, sort_order: Number(b.sort_order) || 0,
    includes: str(b.includes, 2000), image: str(b.image, 300) };
  if (!s.name) throw new HttpError(400, 'Name is required');
  if (s.image && !/^(\/images\/[\w.-]+|https:\/\/\S+)$/.test(s.image)) throw new HttpError(400, 'Photo must be an https:// link (or /images/<file> for a local photo)');
  if (!Number.isInteger(s.duration_min) || s.duration_min < 5 || s.duration_min > 600) throw new HttpError(400, 'Duration must be 5–600 minutes');
  if (!Number.isFinite(s.price_cents) || s.price_cents < 0) throw new HttpError(400, 'Invalid price');
  return s;
}
const serviceCols = (s) => [s.name, s.description, s.duration_min, s.price_cents, s.active, s.sort_order, s.includes, s.image];
admin.post('/services', wrap(async (req, res) => {
  const r = await db.run('INSERT INTO services (name, description, duration_min, price_cents, active, sort_order, includes, image) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
    serviceCols(serviceFields(req.body)));
  res.status(201).json(r.row);
}));
admin.put('/services/:id', wrap(async (req, res) => {
  const r = await db.run('UPDATE services SET name=?, description=?, duration_min=?, price_cents=?, active=?, sort_order=?, includes=?, image=? WHERE id=? RETURNING *',
    [...serviceCols(serviceFields(req.body)), Number(req.params.id) || 0]);
  if (!r.row) throw new HttpError(404, 'Not found');
  res.json(r.row);
}));
admin.delete('/services/:id', wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  // Keep history intact: services with appointments are hidden rather than deleted.
  if (await db.get('SELECT 1 AS x FROM appointments WHERE service_id = ?', [id])) {
    await db.run('UPDATE services SET active = 0 WHERE id = ?', [id]);
    return res.json({ deactivated: true });
  }
  await db.run('DELETE FROM services WHERE id = ?', [id]);
  res.json({ deleted: true });
}));

// Hours, closures, settings
admin.get('/hours', wrap(async (req, res) => res.json(await db.query('SELECT * FROM business_hours ORDER BY weekday'))));
admin.put('/hours', wrap(async (req, res) => {
  if (!Array.isArray(req.body)) throw new HttpError(400, 'Expected an array');
  for (const h of req.body) {
    if (!(h.weekday >= 0 && h.weekday <= 6) || !isTime(h.open_time) || !isTime(h.close_time)) throw new HttpError(400, 'Invalid hours');
    if (!h.closed && toMin(h.close_time) <= toMin(h.open_time)) throw new HttpError(400, 'Closing time must be after opening time');
  }
  await db.tx(async (q) => {
    for (const h of req.body) {
      await q.run(`INSERT INTO business_hours (weekday, open_time, close_time, closed) VALUES (?,?,?,?)
        ON CONFLICT (weekday) DO UPDATE SET open_time = excluded.open_time, close_time = excluded.close_time, closed = excluded.closed`,
      [h.weekday, h.open_time, h.close_time, h.closed ? 1 : 0]);
    }
  });
  res.json(await db.query('SELECT * FROM business_hours ORDER BY weekday'));
}));

admin.get('/blocked', wrap(async (req, res) => res.json(await db.query('SELECT * FROM blocked_dates WHERE date >= ? ORDER BY date', [shopNow().date]))));
admin.post('/blocked', wrap(async (req, res) => {
  if (!isDate(req.body.date)) throw new HttpError(400, 'Invalid date');
  await db.run('INSERT INTO blocked_dates (date, reason) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET reason = excluded.reason',
    [req.body.date, str(req.body.reason, 100)]);
  res.status(201).json({ ok: true });
}));
admin.delete('/blocked/:date', wrap(async (req, res) => {
  await db.run('DELETE FROM blocked_dates WHERE date = ?', [req.params.date]);
  res.json({ ok: true });
}));

admin.get('/settings', wrap(async (req, res) => res.json(await getSettings())));
admin.put('/settings', wrap(async (req, res) => {
  const allowed = { business_name: 'str', phone: 'opt', email: 'opt', address: 'opt',
    slot_interval_min: [5, 240], capacity: [1, 20], min_notice_hours: [0, 720], max_days_ahead: [1, 365] };
  const updates = [];
  for (const [k, rule] of Object.entries(allowed)) {
    if (req.body[k] === undefined) continue;
    let v = req.body[k];
    if (rule === 'str') { v = str(v, 80); if (!v) throw new HttpError(400, 'Business name required'); }
    else if (rule === 'opt') v = str(v, 200);
    else { v = Number(v); if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) throw new HttpError(400, `${k} must be ${rule[0]}–${rule[1]}`); }
    updates.push([k, String(v)]);
  }
  await db.tx(async (q) => {
    for (const u of updates) await q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', u);
  });
  res.json(await getSettings());
}));

// ---------- errors / pages ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('/admin', (req, res) => res.redirect('/admin.html'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  ready().then(() => app.listen(PORT, () => console.log(`Scheduler running → http://localhost:${PORT}  (owner dashboard: /admin)`)));
}
module.exports = app;
