'use strict';

// ---------- Almacenamiento ----------
const K_EVENTS = 'busy.events';
const K_REASONS = 'busy.reasons';
const K_THEME = 'busy.theme';
const K_SCHEDULE = 'busy.schedule';
// Horario por día de la semana (0 = domingo … 6 = sábado). null = día libre.
const DEFAULT_SCHEDULE = { 0: null, 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: null };
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEK_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DEFAULT_REASONS = ['Café', 'Gimnasio', 'Perro'];

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('⚠️ No se pudo guardar'); }
}

let events = load(K_EVENTS, []);   // [{ts: ISO, type: start|pause|resume|end, reason?}]
let reasons = load(K_REASONS, DEFAULT_REASONS.slice());
let schedule = load(K_SCHEDULE, DEFAULT_SCHEDULE);

// ---------- Utilidades de tiempo ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function hm(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}
function human(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
const minutesOfDay = d => d.getHours() * 60 + d.getMinutes();
const fromMinutes = m => `${pad(Math.floor(m / 60))}:${pad(Math.round(m) % 60)}`;
const fmtLongDate = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShortDate = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtWeekday = new Intl.DateTimeFormat('es-ES', { weekday: 'long' });
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

const LABEL = { start: 'Empiezo', pause: 'Pausa', resume: 'Reanudo', end: 'Fin' };
const ICON = { start: '▶️', pause: '⏸️', resume: '▶️', end: '⏹️' };

// ---------- Horario ----------
// Ventana de horario de un día concreto: {from, to, label} o null si es libre
function scheduleWindow(dayK) {
  const base = parseDay(dayK), sch = schedule[base.getDay()];
  if (!sch) return null;
  const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m); };
  return { from: at(sch[0]), to: at(sch[1]), label: `${sch[0]}–${sch[1]}` };
}
// Milisegundos del tramo [a, b) que caen fuera de la ventana
function outside(a, b, win) {
  if (!win) return b - a;
  const inA = Math.max(a, win.from), inB = Math.min(b, win.to);
  return (b - a) - Math.max(0, inB - inA);
}

// ---------- Cálculo ----------
// Recorre los eventos y construye sesiones (de "start" a "end").
// Cada sesión pertenece al día local en que empezó.
function buildSessions(now = new Date()) {
  const sessions = [];
  let cur = null, seg = null;
  for (const e of events) {
    const t = new Date(e.ts);
    if (e.type === 'start') {
      cur = { day: dayKey(t), start: t, end: null, workEnd: null, segs: [], events: [e], pauses: 0, reasons: [], open: true };
      seg = { t: 'w', from: t };
      continue;
    }
    if (!cur) continue;
    cur.events.push(e);
    if (e.type === 'pause') {
      seg.to = t; cur.segs.push(seg);
      seg = { t: 'p', from: t };
      cur.pauses++;
      if (e.reason) cur.reasons.push(e.reason);
    } else if (e.type === 'resume') {
      seg.to = t; cur.segs.push(seg);
      seg = { t: 'w', from: t };
    } else if (e.type === 'end') {
      if (seg.t === 'w') { seg.to = t; cur.segs.push(seg); cur.workEnd = t; }
      else { cur.workEnd = seg.from; cur.pauses--; } // terminó estando en pausa: la jornada acabó al pausar (esa pausa no cuenta)
      cur.end = t; cur.open = false;
      sessions.push(cur); cur = null; seg = null;
    }
  }
  if (cur) {
    cur.segs.push({ ...seg, to: now, live: true });
    sessions.push(cur);
  }
  return sessions;
}

function buildDays(now = new Date()) {
  const map = new Map();
  for (const s of buildSessions(now)) {
    if (!map.has(s.day)) map.set(s.day, { day: s.day, sessions: [] });
    map.get(s.day).sessions.push(s);
  }
  for (const d of map.values()) {
    let work = 0, paused = 0, pauses = 0;
    const reasonCount = {};
    for (const s of d.sessions) {
      for (const g of s.segs) (g.t === 'w' ? (work += g.to - g.from) : (paused += g.to - g.from));
      pauses += s.pauses;
      for (const r of s.reasons) reasonCount[r] = (reasonCount[r] || 0) + 1;
    }
    const first = d.sessions[0], last = d.sessions[d.sessions.length - 1];
    const win = scheduleWindow(d.day);
    let out = 0;
    for (const s of d.sessions) for (const g of s.segs) if (g.t === 'w') out += outside(g.from, g.to, win);
    const endT = last.open ? null : last.workEnd;
    Object.assign(d, {
      win, out,
      early: win ? Math.max(0, win.from - first.start) : 0,
      late: win && endT ? Math.max(0, endT - win.to) : 0,
      work, paused, pauses, reasonCount,
      start: first.start,
      end: last.open ? null : last.workEnd,
      open: last.open,
      rangeEnd: last.open ? now : last.workEnd,
    });
  }
  return map;
}

function currentSession(now = new Date()) {
  const s = buildSessions(now);
  const last = s[s.length - 1];
  return last && last.open ? last : null;
}

function currentState(now = new Date()) {
  const last = events[events.length - 1];
  if (!last || last.type === 'end') {
    const today = buildDays(now).get(dayKey(now));
    return today ? 'done' : 'idle';
  }
  return last.type === 'pause' ? 'paused' : 'working';
}

// ---------- Acciones ----------
function addEvent(type, ts = new Date()) {
  const e = { ts: ts.toISOString(), type };
  events.push(e);
  save(K_EVENTS, events);
  if (navigator.vibrate) navigator.vibrate(30);
  return e;
}

function act(type) {
  addEvent(type);
  render();
  if (type === 'pause' || type === 'resume') openSheet(type);
}

function undo() {
  const e = events.pop();
  if (!e) return;
  save(K_EVENTS, events);
  closeSheet();
  render();
  toast(`Deshecho: ${LABEL[e.type]} ${clock(new Date(e.ts))}`);
}

// ---------- Hoja de motivos ----------
const $ = id => document.getElementById(id);
let sheetFor = null;

function openSheet(type) {
  sheetFor = events[events.length - 1];
  $('sheet-title').textContent = type === 'pause' ? '⏸️ ¿Por qué paras?' : '▶️ ¿Algo que anotar al volver?';
  const chips = $('sheet-chips');
  chips.innerHTML = '';
  for (const r of reasons) {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = r;
    b.onclick = () => setReason(r);
    chips.appendChild(b);
  }
  $('sheet-input').value = '';
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; sheetFor = null; }
function setReason(r) {
  r = r.trim();
  if (r && sheetFor) {
    sheetFor.reason = r;
    save(K_EVENTS, events);
    toast(`Anotado: ${r}`);
  }
  closeSheet();
  render();
}

// ---------- Render: Hoy ----------
function timelineHTML(day) {
  const from = day.start, to = day.rangeEnd;
  const total = Math.max(1, to - from);
  let html = '<div class="timeline">';
  let cursor = from;
  for (const s of day.sessions) {
    if (s.start > cursor) html += `<div class="seg g" style="width:${(s.start - cursor) / total * 100}%"></div>`;
    for (const g of s.segs) {
      const w = (g.to - g.from) / total * 100;
      if (w > 0) html += `<div class="seg ${g.t}" style="width:${w}%"></div>`;
      cursor = g.to;
    }
  }
  html += '</div>';
  html += `<div class="tl-labels"><span>${clock(from)}</span><span>${day.open ? 'ahora' : clock(to)}</span></div>`;
  return html;
}

function renderToday() {
  const now = new Date();
  const todayK = dayKey(now);
  const state = currentState(now);
  document.body.dataset.state = state;
  $('today-date').textContent = fmtLongDate.format(now);

  const undoBtn = $('undo-btn');
  const lastE = events[events.length - 1];
  undoBtn.hidden = !lastE;
  if (lastE) undoBtn.textContent = `↶ Deshacer ${LABEL[lastE.type].toLowerCase()}`;

  // Jornada de otro día sin cerrar
  const open = currentSession(now);
  const stale = open && open.day !== todayK;
  $('stale').hidden = !stale;
  $('today-main').hidden = !!stale;
  if (stale) {
    const lastT = new Date(open.events[open.events.length - 1].ts);
    $('stale-text').textContent = `La jornada del ${fmtLongDate.format(open.start)} empezó a las ${clock(open.start)} y no se finalizó. Último registro: ${LABEL[open.events[open.events.length - 1].type].toLowerCase()} a las ${clock(lastT)}.`;
    const inp = $('stale-time');
    if (!inp.dataset.for || inp.dataset.for !== open.events[0].ts) {
      inp.value = clock(lastT); inp.dataset.for = open.events[0].ts; $('stale-error').textContent = '';
    }
    $('actions').innerHTML = ''; $('actions').dataset.state = 'stale';
    document.body.dataset.state = 'paused';
    return;
  }

  const day = buildDays(now).get(todayK);
  $('state-label').textContent = { idle: 'Sin empezar', working: 'Trabajando', paused: 'En pausa', done: 'Jornada terminada' }[state];

  // Horario (informativo)
  const win = scheduleWindow(todayK);
  const nowOut = state === 'working' && (!win || now < win.from || now > win.to);
  const sch = $('sched');
  sch.classList.toggle('out', nowOut);
  let txt = nowOut ? (win ? `🌙 Fuera de horario · ${win.label}` : '🌙 Hoy es día libre')
                   : (win ? `🕘 Horario ${win.label}` : '🏖️ Hoy no tienes horario');
  if (day && day.out >= 60000) txt += ` · ${hm(day.out)} fuera`;
  sch.textContent = txt;
  $('timer').textContent = hms(day ? day.work : 0);
  $('st-paused').textContent = hm(day ? day.paused : 0);
  $('st-pauses').textContent = day ? day.pauses : 0;
  $('st-start').textContent = day ? clock(day.start) : '—';

  const pi = $('pause-info');
  if (state === 'paused') {
    const p = events[events.length - 1], pt = new Date(p.ts);
    pi.hidden = false;
    pi.textContent = `En pausa desde ${clock(pt)} · ${human(now - pt)}${p.reason ? ' · ' + p.reason : ''}`;
  } else if (state === 'done' && day) {
    pi.hidden = false;
    pi.textContent = `De ${clock(day.start)} a ${clock(day.end)}`;
  } else pi.hidden = true;

  $('today-timeline').innerHTML = day ? timelineHTML(day) : '';
  $('today-timeline').className = day ? '' : 'timeline-empty';

  const list = $('today-events');
  list.innerHTML = '';
  if (day) {
    const evs = day.sessions.flatMap(s => s.events).slice().reverse();
    for (const e of evs) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="t">${clock(new Date(e.ts))}</span><span>${ICON[e.type]} ${LABEL[e.type]}</span>${e.reason ? `<span class="r"></span>` : ''}`;
      if (e.reason) li.querySelector('.r').textContent = e.reason;
      list.appendChild(li);
    }
  }

  const a = $('actions');
  if (a.dataset.state === state) return; // no regenerar botones si no cambia el estado (evita perder toques)
  a.dataset.state = state;
  const btn = (cls, label, type) => `<button class="btn ${cls}" data-act="${type}">${label}</button>`;
  a.innerHTML = {
    idle: btn('btn-main', '▶ Empezar', 'start'),
    working: btn('btn-main', '⏸ Pausar', 'pause') + btn('btn-second', '⏹ Finalizar jornada', 'end'),
    paused: btn('btn-main', '▶ Reanudar', 'resume') + btn('btn-second', '⏹ Finalizar jornada', 'end'),
    done: btn('btn-second', '▶ Empezar otra vez', 'start'),
  }[state];
}

// ---------- Render: Resumen ----------
function renderSummary() {
  const now = new Date();
  const days = [...buildDays(now).values()].sort((a, b) => b.day.localeCompare(a.day));
  const avg = $('avg'), box = $('days');
  if (!days.length) {
    avg.innerHTML = '';
    box.innerHTML = '<div class="empty">Aún no hay jornadas.<br>Empieza una desde la pestaña Hoy.</div>';
    return;
  }
  const closed = days.filter(d => !d.open);
  const mean = arr => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
  const card = (big, label) => `<div class="card"><div class="big">${big}</div><small>${label}</small></div>`;
  avg.innerHTML =
    card(closed.length ? hm(mean(closed.map(d => d.work))) : '—', 'efectivo medio / día') +
    card(closed.length ? hm(mean(closed.map(d => d.paused))) : '—', 'pausa media / día') +
    card(fromMinutes(mean(days.map(d => minutesOfDay(d.start)))), 'inicio medio') +
    card(closed.length ? fromMinutes(mean(closed.map(d => minutesOfDay(d.end)))) : '—', 'fin medio');

  box.innerHTML = `<div class="legend"><span><i style="background:#4ade80"></i>trabajo</span><span><i style="background:#fbbf24"></i>pausa</span><span>${days.length} día${days.length > 1 ? 's' : ''}</span></div>`;
  for (const d of days) {
    const el = document.createElement('div');
    el.className = 'card day';
    el.innerHTML = `
      <div class="day-head"><span class="day-name">${fmtShortDate.format(parseDay(d.day))}</span><span class="day-eff">${hm(d.work)}</span></div>
      ${timelineHTML(d)}
      <div class="day-meta">
        <span>🕘 <b>${clock(d.start)}</b> → <b>${d.open ? 'en curso' : clock(d.end)}</b></span>
        <span>⏸️ <b>${hm(d.paused)}</b> pausado</span>
        <span><b>${d.pauses}</b> pausa${d.pauses === 1 ? '' : 's'}</span>
      </div>
      <div class="day-sched">${schedLine(d)}</div>
      <div class="day-reasons"></div>`;
    const rs = el.querySelector('.day-reasons');
    for (const [r, n] of Object.entries(d.reasonCount)) {
      const s = document.createElement('span');
      s.textContent = n > 1 ? `${r} ×${n}` : r;
      rs.appendChild(s);
    }
    box.appendChild(el);
  }
}

function schedLine(d) {
  const bits = [];
  if (!d.win) bits.push('<span class="out">🏖️ día libre</span>');
  if (d.early >= 60000) bits.push(`<span class="out">⏪ ${human(d.early)} antes</span>`);
  if (d.late >= 60000) bits.push(`<span class="out">⏩ ${human(d.late)} después</span>`);
  if (d.out >= 60000) bits.push(`<span class="out">🌙 <b>${hm(d.out)}</b> fuera de horario</span>`);
  else if (d.win) bits.push(`<span class="in">✓ dentro de horario ${d.win.label}</span>`);
  return bits.join('');
}

// ---------- Render: Ajustes ----------
function renderSchedule() {
  const box = $('schedule-edit');
  box.innerHTML = '';
  for (const wd of WEEK_ORDER) {
    const sch = schedule[wd];
    const row = document.createElement('div');
    row.className = 'sch-row' + (sch ? '' : ' off');
    row.innerHTML = `
      <button type="button" class="sch-day">${WEEK_NAMES[wd]}<small>${sch ? 'laborable' : 'libre'}</small></button>
      <input type="time" class="sch-from" ${sch ? `value="${sch[0]}"` : 'disabled'}>
      <span class="sch-sep">→</span>
      <input type="time" class="sch-to" ${sch ? `value="${sch[1]}"` : 'disabled'}>`;
    row.querySelector('.sch-day').onclick = () => {
      schedule[wd] = sch ? null : DEFAULT_SCHEDULE[1].slice();
      save(K_SCHEDULE, schedule); renderSchedule();
    };
    const onChange = () => {
      const f = row.querySelector('.sch-from').value, t = row.querySelector('.sch-to').value;
      if (f && t && f < t) { schedule[wd] = [f, t]; save(K_SCHEDULE, schedule); toast(`${WEEK_NAMES[wd]}: ${f}–${t}`); }
      else toast('El inicio tiene que ser antes del fin');
    };
    row.querySelector('.sch-from').onchange = onChange;
    row.querySelector('.sch-to').onchange = onChange;
    box.appendChild(row);
  }
}

function renderSettings() {
  renderSchedule();
  const box = $('reasons-edit');
  box.innerHTML = '';
  for (const r of reasons) {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button';
    b.innerHTML = '<span></span><b>×</b>';
    b.querySelector('span').textContent = r;
    b.onclick = () => { reasons = reasons.filter(x => x !== r); save(K_REASONS, reasons); renderSettings(); };
    box.appendChild(b);
  }
  if (!reasons.length) box.innerHTML = '<span class="hint">No hay motivos. Añade alguno.</span>';
  const t = load(K_THEME, 'auto');
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.classList.toggle('active', b.dataset.themeOpt === t));
  const nDays = buildDays().size;
  $('data-count').textContent = `${events.length} evento${events.length === 1 ? '' : 's'} en ${nDays} día${nDays === 1 ? '' : 's'} guardados en este dispositivo.`;
}

// ---------- Exportar ----------
const csvCell = v => {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = rows => rows.map(r => r.map(csvCell).join(';')).join('\r\n');
const stamp = () => { const d = new Date(); return `${dayKey(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`; };

async function deliver(filename, text, mime) {
  const blob = new Blob([mime === 'text/csv' ? '\uFEFF' + text : text], { type: mime });
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch && navigator.canShare) {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; }
      catch (err) { if (err.name === 'AbortError') return; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Descargado ${filename}`);
}

function exportSummary() {
  const days = [...buildDays().values()].sort((a, b) => a.day.localeCompare(b.day));
  const rows = [['fecha', 'dia_semana', 'inicio', 'fin', 'efectivo_hhmm', 'efectivo_min', 'pausado_hhmm', 'pausado_min', 'pausas', 'sesiones', 'motivos', 'horario', 'antes_min', 'despues_min', 'fuera_horario_min']];
  for (const d of days) rows.push([
    d.day, fmtWeekday.format(parseDay(d.day)), clock(d.start), d.open ? '' : clock(d.end),
    hm(d.work), Math.round(d.work / 60000), hm(d.paused), Math.round(d.paused / 60000),
    d.pauses, d.sessions.length,
    Object.entries(d.reasonCount).map(([r, n]) => n > 1 ? `${r} x${n}` : r).join(', '),
    d.win ? d.win.label : 'libre', Math.round(d.early / 60000), Math.round(d.late / 60000), Math.round(d.out / 60000),
  ]);
  deliver(`busy_resumen_${stamp()}.csv`, csv(rows), 'text/csv');
}

function exportEvents() {
  const rows = [['fecha', 'hora', 'evento', 'motivo', 'timestamp']];
  const sessions = buildSessions();
  for (const s of sessions) for (const e of s.events) {
    const t = new Date(e.ts);
    rows.push([s.day, `${clock(t)}:${pad(t.getSeconds())}`, LABEL[e.type], e.reason || '', e.ts]);
  }
  deliver(`busy_eventos_${stamp()}.csv`, csv(rows), 'text/csv');
}

function exportJSON() {
  const data = { app: 'busy', exportedAt: new Date().toISOString(), timezoneOffsetMin: -new Date().getTimezoneOffset(), reasons, schedule, events };
  deliver(`busy_${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

// ---------- UI general ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function applyTheme() {
  const t = load(K_THEME, 'auto');
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function syncThemeColor() {
  const c = getComputedStyle(document.body).backgroundColor;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', c);
}

let view = 'today';
function show(v) {
  view = v;
  document.body.dataset.view = v;
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  window.scrollTo(0, 0);
  render();
}

function render() {
  if (view === 'today') renderToday();
  else if (view === 'summary') renderSummary();
  else renderSettings();
  syncThemeColor();
}

// ---------- Eventos ----------
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
$('actions').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act); });
$('undo-btn').addEventListener('click', undo);
$('sheet-skip').addEventListener('click', () => { closeSheet(); render(); });
$('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') { closeSheet(); render(); } });
$('sheet-form').addEventListener('submit', e => { e.preventDefault(); setReason($('sheet-input').value); });

$('stale-close').addEventListener('click', () => {
  const open = currentSession();
  if (!open) return render();
  const [h, m] = ($('stale-time').value || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) { $('stale-error').textContent = 'Pon una hora.'; return; }
  const lastT = new Date(open.events[open.events.length - 1].ts);
  // La hora se interpreta en el día del último registro (o el siguiente si es anterior)
  let end = new Date(lastT.getFullYear(), lastT.getMonth(), lastT.getDate(), h, m, 0);
  if (end < lastT) { $('stale-error').textContent = `Tiene que ser después de las ${clock(lastT)}.`; return; }
  if (end > new Date()) end = new Date();
  addEvent('end', end);
  toast(`Jornada cerrada a las ${clock(end)}`);
  render();
});

$('reason-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('reason-input').value.trim();
  if (v && !reasons.includes(v)) { reasons.push(v); save(K_REASONS, reasons); }
  $('reason-input').value = '';
  renderSettings();
});

document.querySelectorAll('[data-theme-opt]').forEach(b => b.addEventListener('click', () => {
  save(K_THEME, b.dataset.themeOpt);
  applyTheme();
  render();
}));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());

$('exp-summary').addEventListener('click', exportSummary);
$('exp-events').addEventListener('click', exportEvents);
$('exp-json').addEventListener('click', exportJSON);

let resetTimer;
$('reset').addEventListener('click', () => {
  const b = $('reset');
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = '⚠️ Toca otra vez para borrarlo TODO';
    resetTimer = setTimeout(() => { b.classList.remove('armed'); b.textContent = '🗑️ Borrar todos los registros'; }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  events = [];
  save(K_EVENTS, events);
  b.classList.remove('armed'); b.textContent = '🗑️ Borrar todos los registros';
  toast('Registros borrados');
  render();
});

// Refresco del cronómetro
setInterval(() => { if (view === 'today' && $('sheet').hidden) renderToday(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { events = load(K_EVENTS, []); render(); } });

applyTheme();
show('today');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
