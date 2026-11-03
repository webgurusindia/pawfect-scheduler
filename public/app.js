// Customer-facing booking site
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0);
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m} min`);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const prettyDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const prettyTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const state = { services: [], config: null, service: null, date: null, time: null, month: null };

function goStep(n) {
  document.querySelectorAll('.step').forEach((el) => el.classList.toggle('hidden', Number(el.dataset.step) !== n));
  document.querySelectorAll('#steps div').forEach((el, i) => el.classList.toggle('done', i < n));
}

const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

function renderServices() {
  $('#servicesGrid').innerHTML = state.services.map((s) => `
    <article class="card service-card">
      <div class="photo">
        ${s.image ? `<img src="${esc(s.image)}" alt="${esc(s.name)}" loading="lazy">` : ''}
        <span class="chip">⏱ ${dur(s.duration_min)}</span>
      </div>
      <div class="body">
        <h3>${esc(s.name)}</h3>
        <p class="desc">${esc(s.description)}</p>
        ${lines(s.includes).length ? `<ul class="includes">${lines(s.includes).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<div style="flex:1"></div>'}
        <div class="service-meta">
          <span class="price"><small>from </small>${money(s.price_cents)}</span>
          <button class="btn small" data-book="${s.id}">Book this</button>
        </div>
      </div>
    </article>`).join('') || '<p class="muted">No services available right now.</p>';

  $('#servicePick').innerHTML = state.services.map((s) => `
    <button type="button" class="service-option" data-id="${s.id}">
      <span class="opt-main">${s.image ? `<img src="${esc(s.image)}" alt="">` : ''}
        <span><b>${esc(s.name)}</b><br><span class="muted">${dur(s.duration_min)}</span></span></span>
      <span class="price">${money(s.price_cents)}</span>
    </button>`).join('');
}

function renderContact() {
  const c = state.config;
  const items = [
    c.address && `<li><span>📍</span><a href="https://maps.google.com/?q=${encodeURIComponent(c.address)}" target="_blank" rel="noopener">${esc(c.address)}</a></li>`,
    c.phone && `<li><span>📞</span><a href="tel:${esc(c.phone.replace(/[^+\d]/g, ''))}">${esc(c.phone)}</a></li>`,
    c.email && `<li><span>✉️</span><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></li>`,
  ].filter(Boolean);
  if (items.length) $('#contactList').innerHTML = items.join('') + '<li><span>📅</span><a href="#book">Book online any time</a></li>';
  else $('#contactCard').classList.add('hidden');
}

function selectService(id) {
  state.service = state.services.find((s) => s.id === id);
  state.date = state.time = null;
  document.querySelectorAll('.service-option').forEach((b) => b.classList.toggle('selected', Number(b.dataset.id) === id));
  $('#toStep2').disabled = !state.service;
}

function renderHours() {
  $('#hoursList').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const h = state.config.hours.find((x) => x.weekday === d);
    return `<li><span>${DAYS[d]}</span><b>${!h || h.closed ? 'Closed' : `${prettyTime(h.open_time)} – ${prettyTime(h.close_time)}`}</b></li>`;
  }).join('');
}

function renderCalendar() {
  const m = state.month;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const max = new Date(today); max.setDate(max.getDate() + state.config.max_days_ahead);
  $('#monthLabel').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#prevMonth').disabled = m <= new Date(today.getFullYear(), today.getMonth(), 1);
  $('#nextMonth').disabled = new Date(m.getFullYear(), m.getMonth() + 1, 1) > max;

  let html = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dow">${d}</div>`).join('');
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  for (let i = 0; i < first.getDay(); i++) html += '<div></div>';
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const date = new Date(m.getFullYear(), m.getMonth(), d);
    const h = state.config.hours.find((x) => x.weekday === date.getDay());
    const disabled = date < today || date > max || !h || h.closed;
    const key = ymd(date);
    html += `<button type="button" data-date="${key}" ${disabled ? 'disabled' : ''}
      class="${key === state.date ? 'selected' : ''} ${+date === +today ? 'today' : ''}">${d}</button>`;
  }
  $('#calendar').innerHTML = html;
}

async function selectDate(date) {
  state.date = date; state.time = null;
  $('#toStep3').disabled = true;
  renderCalendar();
  $('#slotsLabel').textContent = 'Loading times…';
  $('#slots').innerHTML = '';
  try {
    const { slots } = await api(`/api/availability?service_id=${state.service.id}&date=${date}`);
    if (state.date !== date) return; // user clicked another date meanwhile
    $('#slotsLabel').textContent = slots.length ? `Available on ${prettyDate(date)}:` : 'No times left on this day — please try another date.';
    $('#slots').innerHTML = slots.map((t) => `<button type="button" data-time="${t}">${prettyTime(t)}</button>`).join('');
  } catch (e) { $('#slotsLabel').textContent = e.message; }
}

function renderSummary() {
  $('#summary').innerHTML = `
    <div><b>${esc(state.service.name)}</b><b>${money(state.service.price_cents)}</b></div>
    <div><span>${prettyDate(state.date)} at ${prettyTime(state.time)}</span><span class="muted">${dur(state.service.duration_min)}</span></div>`;
}

// ---- events ----
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.dataset.book) { selectService(Number(t.dataset.book)); goStep(2); state.month = monthStart(); renderCalendar(); resetSlots(); location.hash = 'book'; }
  else if (t.classList.contains('service-option')) selectService(Number(t.dataset.id));
  else if (t.dataset.date) selectDate(t.dataset.date);
  else if (t.dataset.time) {
    state.time = t.dataset.time;
    document.querySelectorAll('#slots button').forEach((b) => b.classList.toggle('selected', b === t));
    $('#toStep3').disabled = false;
  } else if (t.dataset.back) goStep(Number(t.dataset.back));
  else if (t.dataset.cancel) cancelBooking();
});

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };
const resetSlots = () => { $('#slots').innerHTML = ''; $('#slotsLabel').textContent = 'Select a date to see available times.'; $('#toStep3').disabled = true; };

$('#toStep2').onclick = () => { goStep(2); if (!state.month) state.month = monthStart(); renderCalendar(); if (!state.date) resetSlots(); };
$('#toStep3').onclick = () => { renderSummary(); goStep(3); $('#customer_name').focus(); };
$('#prevMonth').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); renderCalendar(); };
$('#nextMonth').onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); renderCalendar(); };
$('#bookAnother').onclick = () => { $('#detailsForm').reset(); selectService(null); goStep(1); };

$('#detailsForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#bookError').textContent = '';
  $('#submitBtn').disabled = true;
  const body = Object.fromEntries(new FormData(e.target));
  Object.assign(body, { service_id: state.service.id, date: state.date, time: state.time });
  try {
    const r = await api('/api/appointments', { method: 'POST', body });
    $('#confirmText').innerHTML = `<b>${esc(r.dog_name)}</b> is booked for <b>${esc(r.service_name)}</b> on <b>${prettyDate(r.date)}</b> at <b>${prettyTime(r.start_time)}</b>.`;
    $('#confirmRef').textContent = r.ref;
    goStep(4);
  } catch (err) {
    $('#bookError').textContent = err.message;
    if (/taken/.test(err.message)) { goStep(2); selectDate(state.date); }
  } finally { $('#submitBtn').disabled = false; }
};

let lookedUp = null;
function renderLookup(a) {
  lookedUp = a;
  const canCancel = ['booked', 'confirmed'].includes(a.status);
  $('#lookupResult').innerHTML = `
    <div class="summary" style="margin-top:14px">
      <div><b>${esc(a.service_name)} for ${esc(a.dog_name)}</b><span class="badge ${a.status}">${a.status.replace('_', ' ')}</span></div>
      <div><span>${prettyDate(a.date)} at ${prettyTime(a.start_time)}</span><b>${money(a.price_cents)}</b></div>
    </div>
    ${canCancel ? '<button class="btn danger small" data-cancel="1">Cancel this appointment</button>' : ''}`;
}
$('#lookupForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#lookupError').textContent = ''; $('#lookupResult').innerHTML = '';
  try { renderLookup(await api('/api/appointments/lookup', { method: 'POST', body: { ref: $('#lref').value, email: $('#lemail').value } })); }
  catch (err) { $('#lookupError').textContent = err.message; }
};
async function cancelBooking() {
  if (!lookedUp || !confirm('Cancel this appointment?')) return;
  try { renderLookup(await api('/api/appointments/cancel', { method: 'POST', body: { ref: $('#lref').value, email: $('#lemail').value } })); }
  catch (err) { $('#lookupError').textContent = err.message; }
}

// ---- init ----
(async () => {
  $('#year').textContent = new Date().getFullYear();
  try {
    [state.config, state.services] = await Promise.all([api('/api/config'), api('/api/services')]);
    document.querySelectorAll('.biz-name').forEach((el) => (el.textContent = state.config.business_name));
    document.title = `${state.config.business_name} — Book an Appointment`;
    renderServices(); renderHours(); renderContact(); goStep(1);
  } catch { $('#servicesGrid').innerHTML = '<p class="error">Could not load services. Please refresh.</p>'; }
})();
