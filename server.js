const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { db, getSettings } = require('./db');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD not set — using default "changeme". Set it before going live.');
}

// ---------- helpers ----------
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekdayOf = (date) => new Date(date + 'T00:00:00').getDay();
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function makeRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return s;
}

/**
 * Returns the list of start times (in minutes) open for a service on a date.
 * opts.ignoreNotice  - admin bookings skip the min-notice / max-days rules
 * opts.excludeId     - ignore an appointment (when rescheduling it)
 */
function availableSlots(date, durationMin, opts = {}) {
  const settings = getSettings();
  const interval = Number(settings.slot_interval_min) || 30;
  const capacity = Number(settings.capacity) || 1;

  if (db.prepare('SELECT 1 FROM blocked_dates WHERE date = ?').get(date)) return [];
  const hours = db.prepare('SELECT * FROM business_hours WHERE weekday = ?').get(weekdayOf(date));
  if (!hours || hours.closed) return [];

  const now = new Date();
  const today = localDateStr(now);
  if (!opts.ignoreNotice) {
    const maxDate = new Date(now); maxDate.setDate(maxDate.getDate() + Number(settings.max_days_ahead || 60));
    if (date < today || date > localDateStr(maxDate)) return [];
  }
  // earliest bookable minute on this date
  let earliest = -1;
  if (!opts.ignoreNotice) {
    const cutoff = new Date(now.getTime() + Number(settings.min_notice_hours || 0) * 3600e3);
    const cutoffDate = localDateStr(cutoff);
    if (date < cutoffDate) return [];
    if (date === cutoffDate) earliest = cutoff.getHours() * 60 + cutoff.getMinutes();
  }

  const appts = db.prepare(
    `SELECT start_min, end_min FROM appointments
     WHERE date = ? AND status NOT IN ('cancelled','no_show') AND id != ?`
  ).all(date, opts.excludeId || -1);

  const open = toMin(hours.open_time), close = toMin(hours.close_time);
  const slots = [];
  for (let t = open; t + durationMin <= close; t += interval) {
    if (t < earliest) continue;
    const overlapping = appts.filter((a) => a.start_min < t + durationMin && a.end_min > t).length;
    if (overlapping < capacity) slots.push(t);
  }
  return slots;
}

function apptView(a) {
  return { ...a, start_time: toHHMM(a.start_min), end_time: toHHMM(a.end_min) };
}

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

function createAppointment(body, { admin = false } = {}) {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(body.service_id));
  if (!service || (!admin && !service.active)) throw new HttpError(400, 'Please choose a service.');
  if (!isDate(body.date) || !isTime(body.time)) throw new HttpError(400, 'Please choose a date and time.');
  const c = validateCustomer(body);
  const start = toMin(body.time);

  return withTransaction(() => {
    // Re-check availability inside the transaction so two people can't grab the same slot.
    if (!admin || !body.force) {
      const slots = availableSlots(body.date, service.duration_min, { ignoreNotice: admin });
      if (!slots.includes(start)) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another.');
    }
    const ref = makeRef();
    const r = db.prepare(
      `INSERT INTO appointments (ref, service_id, date, start_min, end_min, customer_name, email, phone,
         dog_name, breed, dog_size, notes, price_cents, status, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(ref, service.id, body.date, start, start + service.duration_min, c.customer_name, c.email, c.phone,
      c.dog_name, c.breed, c.dog_size, c.notes, service.price_cents,
      admin ? 'confirmed' : 'booked', admin ? 'admin' : 'online');
    return getAppointment(r.lastInsertRowid);
  });
}

function getAppointment(id) {
  const a = db.prepare(
    `SELECT a.*, s.name AS service_name, s.duration_min FROM appointments a
     JOIN services s ON s.id = a.service_id WHERE a.id = ?`
  ).get(id);
  return a && apptView(a);
}

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  const s = getSettings();
  res.json({ business_name: s.business_name, max_days_ahead: Number(s.max_days_ahead),
    hours: db.prepare('SELECT * FROM business_hours ORDER BY weekday').all() });
});

app.get('/api/services', (req, res) => {
  res.json(db.prepare('SELECT id, name, description, duration_min, price_cents FROM services WHERE active = 1 ORDER BY sort_order, id').all());
});

app.get('/api/availability', wrap((req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(Number(req.query.service_id));
  if (!service) throw new HttpError(400, 'Unknown service');
  if (!isDate(req.query.date)) throw new HttpError(400, 'Invalid date');
  res.json({ date: req.query.date, slots: availableSlots(req.query.date, service.duration_min).map(toHHMM) });
}));

app.post('/api/appointments', wrap((req, res) => {
  const a = createAppointment(req.body);
  res.status(201).json({ ref: a.ref, date: a.date, start_time: a.start_time, service_name: a.service_name,
    dog_name: a.dog_name, price_cents: a.price_cents });
}));

// Customers look up / cancel with booking ref + email (acts as a lightweight password).
function findCustomerAppt(ref, email) {
  const a = db.prepare(
    `SELECT a.*, s.name AS service_name FROM appointments a JOIN services s ON s.id = a.service_id
     WHERE a.ref = ? AND a.email = ?`
  ).get(str(ref, 12).toUpperCase(), str(email, 120).toLowerCase());
  if (!a) throw new HttpError(404, 'No booking found with that reference and email.');
  return a;
}
const publicAppt = (a) => ({ ref: a.ref, date: a.date, start_time: toHHMM(a.start_min), service_name: a.service_name,
  dog_name: a.dog_name, status: a.status, price_cents: a.price_cents });

app.post('/api/appointments/lookup', wrap((req, res) => {
  res.json(publicAppt(findCustomerAppt(req.body.ref, req.body.email)));
}));

app.post('/api/appointments/cancel', wrap((req, res) => {
  const a = findCustomerAppt(req.body.ref, req.body.email);
  if (!['booked', 'confirmed'].includes(a.status)) throw new HttpError(400, 'This booking can no longer be cancelled online.');
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(a.id);
  res.json(publicAppt({ ...a, status: 'cancelled' }));
}));

// ---------- admin auth (signed cookie) ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function makeToken() {
  const exp = Date.now() + 12 * 3600e3;
  return `${exp}.${sign(String(exp))}`;
}
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

const loginAttempts = new Map(); // ip -> {count, until}
app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (rec.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const given = Buffer.from(String(req.body.password || ''));
  const actual = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === actual.length && crypto.timingSafeEqual(given, actual);
  if (!ok) {
    rec.count++;
    if (rec.count >= 5) { rec.until = Date.now() + 5 * 60e3; rec.count = 0; }
    loginAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Incorrect password' });
  }
  loginAttempts.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
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
admin.get('/appointments', wrap((req, res) => {
  const from = isDate(req.query.from) ? req.query.from : localDateStr(new Date());
  const to = isDate(req.query.to) ? req.query.to : from;
  const params = [from, to];
  let sql = `SELECT a.*, s.name AS service_name FROM appointments a JOIN services s ON s.id = a.service_id
             WHERE a.date BETWEEN ? AND ?`;
  if (req.query.status) { sql += ' AND a.status = ?'; params.push(String(req.query.status)); }
  if (req.query.q) {
    sql += ' AND (a.customer_name LIKE ? OR a.dog_name LIKE ? OR a.email LIKE ? OR a.phone LIKE ? OR a.ref LIKE ?)';
    const q = `%${str(req.query.q, 60)}%`; params.push(q, q, q, q, q);
  }
  sql += ' ORDER BY a.date, a.start_min';
  res.json(db.prepare(sql).all(...params).map(apptView));
}));

admin.post('/appointments', wrap((req, res) => res.status(201).json(createAppointment(req.body, { admin: true }))));

admin.patch('/appointments/:id', wrap((req, res) => {
  const a = getAppointment(Number(req.params.id));
  if (!a) throw new HttpError(404, 'Not found');
  const b = req.body;
  withTransaction(() => {
    if (b.status !== undefined) {
      if (!['booked', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(b.status)) throw new HttpError(400, 'Bad status');
      db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(b.status, a.id);
    }
    if (b.admin_notes !== undefined) db.prepare('UPDATE appointments SET admin_notes = ? WHERE id = ?').run(str(b.admin_notes, 2000), a.id);
    if (b.date !== undefined || b.time !== undefined) { // reschedule
      const date = b.date ?? a.date, time = b.time ?? a.start_time;
      if (!isDate(date) || !isTime(time)) throw new HttpError(400, 'Invalid date/time');
      const start = toMin(time);
      if (!b.force && !availableSlots(date, a.duration_min, { ignoreNotice: true, excludeId: a.id }).includes(start)) {
        throw new HttpError(409, 'That time is not available (outside hours or overlapping). Tick "override" to force it.');
      }
      db.prepare('UPDATE appointments SET date = ?, start_min = ?, end_min = ? WHERE id = ?').run(date, start, start + a.duration_min, a.id);
    }
  });
  res.json(getAppointment(a.id));
}));

admin.get('/slots', wrap((req, res) => {
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(req.query.service_id));
  if (!service || !isDate(req.query.date)) throw new HttpError(400, 'Bad request');
  res.json(availableSlots(req.query.date, service.duration_min, { ignoreNotice: true, excludeId: Number(req.query.exclude) || 0 }).map(toHHMM));
}));

admin.get('/stats', (req, res) => {
  const today = localDateStr(new Date());
  const d = new Date(); d.setDate(d.getDate() - d.getDay());
  const weekStart = localDateStr(d); d.setDate(d.getDate() + 6);
  const weekEnd = localDateStr(d);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  res.json({
    today: one("SELECT COUNT(*) n FROM appointments WHERE date = ? AND status NOT IN ('cancelled','no_show')", today).n,
    week: one("SELECT COUNT(*) n, COALESCE(SUM(price_cents),0) rev FROM appointments WHERE date BETWEEN ? AND ? AND status NOT IN ('cancelled','no_show')", weekStart, weekEnd),
    pending: one("SELECT COUNT(*) n FROM appointments WHERE status = 'booked' AND date >= ?", today).n,
  });
});

// Services
admin.get('/services', (req, res) => res.json(db.prepare('SELECT * FROM services ORDER BY sort_order, id').all()));
function serviceFields(b) {
  const s = { name: str(b.name, 80), description: str(b.description, 500), duration_min: Number(b.duration_min),
    price_cents: Math.round(Number(b.price_cents)), active: b.active === false || b.active === 0 ? 0 : 1, sort_order: Number(b.sort_order) || 0 };
  if (!s.name) throw new HttpError(400, 'Name is required');
  if (!Number.isInteger(s.duration_min) || s.duration_min < 5 || s.duration_min > 600) throw new HttpError(400, 'Duration must be 5–600 minutes');
  if (!Number.isFinite(s.price_cents) || s.price_cents < 0) throw new HttpError(400, 'Invalid price');
  return s;
}
admin.post('/services', wrap((req, res) => {
  const s = serviceFields(req.body);
  const r = db.prepare('INSERT INTO services (name, description, duration_min, price_cents, active, sort_order) VALUES (?,?,?,?,?,?)')
    .run(s.name, s.description, s.duration_min, s.price_cents, s.active, s.sort_order);
  res.status(201).json(db.prepare('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid));
}));
admin.put('/services/:id', wrap((req, res) => {
  const s = serviceFields(req.body);
  const r = db.prepare('UPDATE services SET name=?, description=?, duration_min=?, price_cents=?, active=?, sort_order=? WHERE id=?')
    .run(s.name, s.description, s.duration_min, s.price_cents, s.active, s.sort_order, Number(req.params.id));
  if (!r.changes) throw new HttpError(404, 'Not found');
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(Number(req.params.id)));
}));
admin.delete('/services/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  // Keep history intact: services with appointments are deactivated rather than deleted.
  if (db.prepare('SELECT 1 FROM appointments WHERE service_id = ?').get(id)) {
    db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(id);
    return res.json({ deactivated: true });
  }
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
  res.json({ deleted: true });
}));

// Hours, closures, settings
admin.get('/hours', (req, res) => res.json(db.prepare('SELECT * FROM business_hours ORDER BY weekday').all()));
admin.put('/hours', wrap((req, res) => {
  if (!Array.isArray(req.body)) throw new HttpError(400, 'Expected an array');
  withTransaction(() => {
    const up = db.prepare('INSERT OR REPLACE INTO business_hours (weekday, open_time, close_time, closed) VALUES (?,?,?,?)');
    for (const h of req.body) {
      if (!(h.weekday >= 0 && h.weekday <= 6) || !isTime(h.open_time) || !isTime(h.close_time)) throw new HttpError(400, 'Invalid hours');
      if (!h.closed && toMin(h.close_time) <= toMin(h.open_time)) throw new HttpError(400, 'Closing time must be after opening time');
      up.run(h.weekday, h.open_time, h.close_time, h.closed ? 1 : 0);
    }
  });
  res.json(db.prepare('SELECT * FROM business_hours ORDER BY weekday').all());
}));

admin.get('/blocked', (req, res) => res.json(db.prepare('SELECT * FROM blocked_dates WHERE date >= ? ORDER BY date').all(localDateStr(new Date()))));
admin.post('/blocked', wrap((req, res) => {
  if (!isDate(req.body.date)) throw new HttpError(400, 'Invalid date');
  db.prepare('INSERT OR REPLACE INTO blocked_dates (date, reason) VALUES (?, ?)').run(req.body.date, str(req.body.reason, 100));
  res.status(201).json({ ok: true });
}));
admin.delete('/blocked/:date', (req, res) => {
  db.prepare('DELETE FROM blocked_dates WHERE date = ?').run(req.params.date);
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json(getSettings()));
admin.put('/settings', wrap((req, res) => {
  const allowed = { business_name: 'str', slot_interval_min: [5, 240], capacity: [1, 20], min_notice_hours: [0, 720], max_days_ahead: [1, 365] };
  withTransaction(() => {
    for (const [k, rule] of Object.entries(allowed)) {
      if (req.body[k] === undefined) continue;
      let v = req.body[k];
      if (rule === 'str') { v = str(v, 80); if (!v) throw new HttpError(400, 'Business name required'); }
      else { v = Number(v); if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) throw new HttpError(400, `${k} must be ${rule[0]}–${rule[1]}`); }
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(v));
    }
  });
  res.json(getSettings());
}));

// ---------- errors / pages ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Scheduler running → http://localhost:${PORT}  (owner dashboard: /admin)`));
}
module.exports = app;
