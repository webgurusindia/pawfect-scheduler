// Owner dashboard
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (c / 100).toFixed(2);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const prettyDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
const prettyTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS_LABEL = { booked: 'New', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };

async function api(path, opts = {}) {
  const res = await fetch('/api/admin' + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please sign in again'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2200);
}

let services = [];
const view = { from: ymd(new Date()), days: 7 };

// ---------- auth ----------
function showLogin() { $('#loginView').classList.remove('hidden'); $('#appView').classList.add('hidden'); }
async function showApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  services = await api('/services');
  loadSchedule();
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('#loginError').textContent = '';
  try { await api('/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; showApp(); }
  catch (err) { $('#loginError').textContent = err.message; }
};
$('#logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };

// ---------- tabs ----------
$$('[data-tab]').forEach((b) => (b.onclick = () => {
  $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
  ({ schedule: loadSchedule, services: loadServices, hours: loadHours, settings: loadSettings })[b.dataset.tab]();
}));

// ---------- schedule ----------
async function loadStats() {
  const s = await api('/stats');
  $('#stats').innerHTML = `
    <div class="card stat"><div class="n">${s.today}</div><div class="l">Appointments today</div></div>
    <div class="card stat"><div class="n">${s.pending}</div><div class="l">New bookings to confirm</div></div>
    <div class="card stat"><div class="n">${s.week.n}</div><div class="l">This week</div></div>
    <div class="card stat"><div class="n">${money(s.week.rev)}</div><div class="l">Booked revenue this week</div></div>`;
}

async function loadSchedule() {
  $('#dateFrom').value = view.from;
  loadStats();
  const q = new URLSearchParams({ from: view.from, to: addDays(view.from, view.days - 1) });
  if ($('#statusSel').value) q.set('status', $('#statusSel').value);
  if ($('#searchBox').value.trim()) q.set('q', $('#searchBox').value.trim());
  const appts = await api('/appointments?' + q);
  if (!appts.length) { $('#apptList').innerHTML = '<div class="card muted">No appointments in this range.</div>'; return; }
  const byDay = {};
  appts.forEach((a) => (byDay[a.date] ||= []).push(a));
  $('#apptList').innerHTML = Object.entries(byDay).map(([date, list]) => `
    <div class="day-group">
      <h3>${prettyDate(date)} · ${list.filter((a) => !['cancelled', 'no_show'].includes(a.status)).length} booked</h3>
      ${list.map((a) => `
        <div class="card appt s-${a.status}" data-id="${a.id}">
          <div class="time">${prettyTime(a.start_time)}<small>to ${prettyTime(a.end_time)}</small></div>
          <div class="who"><b>${esc(a.dog_name)}</b>${a.breed ? ` <span class="muted">(${esc(a.breed)})</span>` : ''} — ${esc(a.service_name)}<br>
            <span class="muted">${esc(a.customer_name)} · ${esc(a.phone)}</span></div>
          <span class="badge ${a.status}">${STATUS_LABEL[a.status]}</span>
        </div>`).join('')}
    </div>`).join('');
  window._appts = Object.fromEntries(appts.map((a) => [a.id, a]));
}

$('#apptList').onclick = (e) => { const el = e.target.closest('.appt'); if (el) openAppt(window._appts[el.dataset.id]); };
$('#dateFrom').onchange = () => { if ($('#dateFrom').value) { view.from = $('#dateFrom').value; loadSchedule(); } };
$('#prevRange').onclick = () => { view.from = addDays(view.from, -view.days); loadSchedule(); };
$('#nextRange').onclick = () => { view.from = addDays(view.from, view.days); loadSchedule(); };
$('#todayBtn').onclick = () => { view.from = ymd(new Date()); loadSchedule(); };
$('#rangeSel').onchange = () => { view.days = Number($('#rangeSel').value); loadSchedule(); };
$('#statusSel').onchange = loadSchedule;
let searchT; $('#searchBox').oninput = () => { clearTimeout(searchT); searchT = setTimeout(loadSchedule, 250); };

async function fillSlots(select, serviceId, date, current, exclude) {
  select.innerHTML = '<option>Loading…</option>';
  const slots = await api(`/slots?service_id=${serviceId}&date=${date}${exclude ? '&exclude=' + exclude : ''}`).catch(() => []);
  if (current && !slots.includes(current)) slots.unshift(current);
  select.innerHTML = slots.length ? slots.map((t) => `<option value="${t}" ${t === current ? 'selected' : ''}>${prettyTime(t)}</option>`).join('')
    : '<option value="">No free times (use override)</option>';
}

function openAppt(a) {
  const row = (k, v) => (v ? `<div class="detail-row"><span>${k}</span><span>${v}</span></div>` : '');
  $('#apptDetail').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start">
      <h2>${esc(a.dog_name)} · ${esc(a.service_name)}</h2>
      <span class="badge ${a.status}">${STATUS_LABEL[a.status]}</span>
    </div>
    ${row('When', `${prettyDate(a.date)}, ${prettyTime(a.start_time)}–${prettyTime(a.end_time)}`)}
    ${row('Owner', esc(a.customer_name))}
    ${row('Phone', `<a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>`)}
    ${row('Email', `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>`)}
    ${row('Breed', esc(a.breed))}${row('Size', esc(a.dog_size))}
    ${row('Price', money(a.price_cents))}
    ${row('Reference', esc(a.ref))}
    ${row('Booked', `${esc(a.source)} · ${esc(a.created_at)} UTC`)}
    ${a.notes ? `<p><b>Customer notes:</b><br>${esc(a.notes)}</p>` : ''}

    <div class="btn-row">
      ${a.status === 'booked' ? '<button class="btn teal small" data-status="confirmed">✓ Confirm</button>' : ''}
      ${['booked', 'confirmed'].includes(a.status) ? `
        <button class="btn small" data-status="completed">Mark completed</button>
        <button class="btn ghost small" data-status="no_show">No-show</button>
        <button class="btn danger small" data-status="cancelled">Cancel</button>` : '<button class="btn ghost small" data-status="confirmed">Re-open</button>'}
    </div>

    <h3 style="margin-top:20px">Reschedule</h3>
    <div class="toolbar">
      <input type="date" id="rsDate" value="${a.date}">
      <select id="rsTime"></select>
      <label style="display:flex;gap:6px;align-items:center;font-weight:600"><input type="checkbox" id="rsForce" style="width:auto"> override</label>
      <input type="time" id="rsManual" class="hidden" value="${a.start_time}">
      <button class="btn small ghost" id="rsSave">Move</button>
    </div>

    <div class="field"><label for="adminNotes">Private notes</label><textarea id="adminNotes" rows="3">${esc(a.admin_notes)}</textarea></div>
    <p class="error" id="apptError"></p>
    <div class="btn-row" style="justify-content:space-between">
      <button class="btn small" id="saveNotes">Save notes</button>
      <button class="btn ghost small" id="closeAppt">Close</button>
    </div>`;
  const d = $('#apptDialog'); d.showModal();
  const update = async (body, msg) => {
    try { const r = await api('/appointments/' + a.id, { method: 'PATCH', body }); toast(msg); d.close(); loadSchedule(); return r; }
    catch (err) { $('#apptError').textContent = err.message; }
  };
  fillSlots($('#rsTime'), a.service_id, a.date, a.start_time, a.id);
  $('#rsDate').onchange = () => fillSlots($('#rsTime'), a.service_id, $('#rsDate').value, null, a.id);
  $('#rsForce').onchange = () => { $('#rsManual').classList.toggle('hidden', !$('#rsForce').checked); $('#rsTime').classList.toggle('hidden', $('#rsForce').checked); };
  $('#rsSave').onclick = () => {
    const force = $('#rsForce').checked;
    const time = force ? $('#rsManual').value : $('#rsTime').value;
    if (!time) return ($('#apptError').textContent = 'Pick a time');
    update({ date: $('#rsDate').value, time, force }, 'Appointment moved');
  };
  $$('[data-status]', d).forEach((b) => (b.onclick = () => update({ status: b.dataset.status }, 'Status updated')));
  $('#saveNotes').onclick = () => update({ admin_notes: $('#adminNotes').value }, 'Notes saved');
  $('#closeAppt').onclick = () => d.close();
}

$('#newApptBtn').onclick = () => {
  const active = services.filter((s) => s.active);
  const f = $('#newApptForm');
  f.innerHTML = `
    <h2>New appointment</h2>
    <p class="muted">For phone or walk-in bookings. Notice rules don't apply here.</p>
    <div class="field"><label>Service</label><select name="service_id">${active.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.duration_min} min, ${money(s.price_cents)})</option>`).join('')}</select></div>
    <div class="grid2">
      <div class="field"><label>Date</label><input type="date" name="date" value="${view.from}" required></div>
      <div class="field"><label>Time</label><select name="time"></select>
        <input type="time" name="manual_time" class="hidden"></div>
    </div>
    <label style="display:flex;gap:6px;align-items:center;font-weight:600;margin-bottom:14px"><input type="checkbox" name="force" style="width:auto"> Override (any time, even if overlapping or outside hours)</label>
    <div class="grid2">
      <div class="field"><label>Customer name</label><input name="customer_name" required></div>
      <div class="field"><label>Phone</label><input name="phone" required></div>
      <div class="field"><label>Email</label><input name="email" type="email" required></div>
      <div class="field"><label>Dog's name</label><input name="dog_name" required></div>
      <div class="field"><label>Breed</label><input name="breed"></div>
      <div class="field"><label>Size</label><input name="dog_size"></div>
    </div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2"></textarea></div>
    <p class="error" id="newApptError"></p>
    <div class="btn-row" style="justify-content:space-between"><button class="btn">Create</button><button type="button" class="btn ghost" id="cancelNew">Cancel</button></div>`;
  const refresh = () => fillSlots(f.time, f.service_id.value, f.date.value);
  f.service_id.onchange = refresh; f.date.onchange = refresh; refresh();
  f.force.onchange = () => { f.manual_time.classList.toggle('hidden', !f.force.checked); f.time.classList.toggle('hidden', f.force.checked); };
  $('#cancelNew').onclick = () => $('#newApptDialog').close();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    body.force = f.force.checked;
    if (body.force) body.time = body.manual_time;
    try { await api('/appointments', { method: 'POST', body }); $('#newApptDialog').close(); toast('Appointment created'); view.from = body.date; loadSchedule(); }
    catch (err) { $('#newApptError').textContent = err.message; }
  };
  $('#newApptDialog').showModal();
};

// ---------- services ----------
async function loadServices() {
  services = await api('/services');
  $('#servicesTable').innerHTML = `<tr><th>Service</th><th>Duration</th><th>Price</th><th>Status</th><th></th></tr>` +
    services.map((s) => `<tr>
      <td><b>${esc(s.name)}</b><br><span class="muted">${esc(s.description)}</span></td>
      <td>${s.duration_min} min</td><td>${money(s.price_cents)}</td>
      <td>${s.active ? '<span class="badge confirmed">Live</span>' : '<span class="badge completed">Hidden</span>'}</td>
      <td><button class="btn ghost small" data-edit="${s.id}">Edit</button></td></tr>`).join('');
}
$('#servicesTable').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) openService(services.find((s) => s.id == b.dataset.edit)); };
$('#newServiceBtn').onclick = () => openService(null);

function openService(s) {
  const f = $('#serviceForm');
  f.innerHTML = `
    <h2>${s ? 'Edit service' : 'New service'}</h2>
    <div class="field"><label>Name</label><input name="name" value="${esc(s?.name)}" required></div>
    <div class="field"><label>Description</label><textarea name="description" rows="3">${esc(s?.description)}</textarea></div>
    <div class="grid2">
      <div class="field"><label>Duration (minutes)</label><input name="duration_min" type="number" min="5" max="600" step="5" value="${s?.duration_min ?? 60}" required></div>
      <div class="field"><label>Price ($)</label><input name="price" type="number" min="0" step="0.01" value="${s ? (s.price_cents / 100).toFixed(2) : ''}" required></div>
      <div class="field"><label>Display order</label><input name="sort_order" type="number" value="${s?.sort_order ?? 0}"></div>
      <div class="field"><label>Visible to customers</label><select name="active"><option value="1">Yes</option><option value="0" ${s && !s.active ? 'selected' : ''}>No</option></select></div>
    </div>
    <p class="error" id="serviceError"></p>
    <div class="btn-row" style="justify-content:space-between">
      <span><button class="btn">Save</button> <button type="button" class="btn ghost" id="cancelService">Cancel</button></span>
      ${s ? '<button type="button" class="btn danger small" id="deleteService">Delete</button>' : ''}
    </div>`;
  $('#cancelService').onclick = () => $('#serviceDialog').close();
  if (s) $('#deleteService').onclick = async () => {
    if (!confirm(`Delete "${s.name}"?`)) return;
    const r = await api('/services/' + s.id, { method: 'DELETE' });
    toast(r.deactivated ? 'Has past bookings — hidden instead of deleted' : 'Service deleted');
    $('#serviceDialog').close(); loadServices();
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: f.name.value, description: f.description.value, duration_min: Number(f.duration_min.value),
      price_cents: Math.round(Number(f.price.value) * 100), sort_order: Number(f.sort_order.value), active: f.active.value === '1' };
    try { await api(s ? '/services/' + s.id : '/services', { method: s ? 'PUT' : 'POST', body }); $('#serviceDialog').close(); toast('Saved'); loadServices(); }
    catch (err) { $('#serviceError').textContent = err.message; }
  };
  $('#serviceDialog').showModal();
}

// ---------- hours & closures ----------
async function loadHours() {
  const [hours, blocked] = await Promise.all([api('/hours'), api('/blocked')]);
  $('#hoursTable').innerHTML = '<tr><th>Day</th><th>Open</th><th>Close</th><th>Closed</th></tr>' +
    [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const h = hours.find((x) => x.weekday === d) || { open_time: '09:00', close_time: '17:00', closed: 1 };
      return `<tr data-day="${d}"><td><b>${DAYS[d]}</b></td>
        <td><input type="time" class="open" value="${h.open_time}"></td>
        <td><input type="time" class="close" value="${h.close_time}"></td>
        <td><input type="checkbox" class="closed" style="width:auto" ${h.closed ? 'checked' : ''}></td></tr>`;
    }).join('');
  $('#blockedList').innerHTML = blocked.length ? `<table>${blocked.map((b) => `<tr><td><b>${prettyDate(b.date)}</b><br><span class="muted">${esc(b.reason)}</span></td>
    <td style="text-align:right"><button class="btn ghost small" data-unblock="${b.date}">Remove</button></td></tr>`).join('')}</table>`
    : '<p class="muted">No upcoming closures.</p>';
}
$('#hoursForm').onsubmit = async (e) => {
  e.preventDefault(); $('#hoursError').textContent = '';
  const body = $$('#hoursTable tr[data-day]').map((tr) => ({ weekday: Number(tr.dataset.day), open_time: $('.open', tr).value,
    close_time: $('.close', tr).value, closed: $('.closed', tr).checked }));
  try { await api('/hours', { method: 'PUT', body }); toast('Hours saved'); } catch (err) { $('#hoursError').textContent = err.message; }
};
$('#blockForm').onsubmit = async (e) => {
  e.preventDefault();
  await api('/blocked', { method: 'POST', body: { date: $('#blockDate').value, reason: $('#blockReason').value } });
  $('#blockForm').reset(); toast('Date closed'); loadHours();
};
$('#blockedList').onclick = async (e) => {
  const b = e.target.closest('[data-unblock]'); if (!b) return;
  await api('/blocked/' + b.dataset.unblock, { method: 'DELETE' }); loadHours();
};

// ---------- settings ----------
async function loadSettings() {
  const s = await api('/settings');
  for (const [k, v] of Object.entries(s)) if ($('#settingsForm').elements[k]) $('#settingsForm').elements[k].value = v;
}
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault(); $('#settingsError').textContent = '';
  try { await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Settings saved'); }
  catch (err) { $('#settingsError').textContent = err.message; }
};

// ---------- init ----------
api('/me').then(showApp).catch(showLogin);
