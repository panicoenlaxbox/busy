'use strict';

// ---------- Almacenamiento ----------
const K_EVENTS = 'busy.events';
const K_REASONS = 'busy.reasons';
const K_THEME = 'busy.theme';
const K_SCHEDULE = 'busy.schedule';
const K_DAYSOFF = 'busy.daysoff';
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

let events = load(K_EVENTS, []);   // [{ts: ISO, type: start|pause|resume|end, reasons?: [motivos rápidos], note?: texto libre}]
let reasons = load(K_REASONS, DEFAULT_REASONS.slice());
let schedule = load(K_SCHEDULE, DEFAULT_SCHEDULE);
let daysOff = new Set(load(K_DAYSOFF, []));   // fechas 'YYYY-MM-DD' marcadas como libres
const saveDaysOff = () => save(K_DAYSOFF, [...daysOff].sort());

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
// Formatos fijos, independientes de la configuración del móvil: dd/mm/yyyy y 24 h
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ddmmyyyy = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtLongDate = { format: d => `${cap(WEEKDAYS[d.getDay()])} ${ddmmyyyy(d)}` };
const fmtShortDate = { format: d => `${cap(WEEKDAYS[d.getDay()].slice(0, 3))} ${ddmmyyyy(d)}` };
const fmtWeekday = { format: d => WEEKDAYS[d.getDay()] };

// Selector de hora propio (00–23 : 00–59), sin depender del formato 12/24 h del sistema
function timePickerHTML(cls, value, step = 1, disabled = false) {
  const [vh, vm] = (value || '00:00').split(':');
  const hours = Array.from({ length: 24 }, (_, i) => pad(i));
  const mins = Array.from({ length: 60 / step }, (_, i) => pad(i * step));
  if (!mins.includes(vm)) { mins.push(vm); mins.sort(); }
  const opts = (list, v) => list.map(x => `<option${x === v ? ' selected' : ''}>${x}</option>`).join('');
  const dis = disabled ? ' disabled' : '';
  return `<span class="tp ${cls}"><select class="tp-h"${dis}>${opts(hours, vh)}</select><b>:</b><select class="tp-m"${dis}>${opts(mins, vm)}</select></span>`;
}
const tpGet = el => `${el.querySelector('.tp-h').value}:${el.querySelector('.tp-m').value}`;
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

const LABEL = { start: 'Empiezo', pause: 'Pausa', resume: 'Reanudo', end: 'Fin' };
const ICON = { start: '▶️', pause: '⏸️', resume: '▶️', end: '⏹️' };

// ---------- Horario ----------
// Ventana de horario de un día concreto: {from, to, label} o null si es libre
function scheduleWindow(dayK) {
  const base = parseDay(dayK), sch = schedule[base.getDay()];
  if (!sch || daysOff.has(dayK)) return null;
  const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m); };
  const brk = sch[2] || 0;
  return { from: at(sch[0]), to: at(sch[1]), brk, label: `${sch[0]}–${sch[1]}` };
}
// Tipo de día y horas esperadas según horario y días libres
function dayType(dayK) {
  if (daysOff.has(dayK)) return 'día libre';
  return schedule[parseDay(dayK).getDay()] ? 'laborable' : 'sin horario';
}
function expectedMs(dayK) {
  const w = scheduleWindow(dayK);
  return w ? Math.max(0, (w.to - w.from) - w.brk * 60000) : 0; // franja menos descanso no computable
}
// Duración con signo: +1:20 / -0:35
function signedHM(ms) {
  const m = Math.round(ms / 60000), a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${Math.floor(a / 60)}:${pad(a % 60)}`;
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
      cur.reasons.push(...eventTags(e));
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
const escapeHTML = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let sheetFor = null;
const sheetSel = new Set(); // motivos rápidos marcados en la hoja
// Motivos de un evento: lista de motivos rápidos + nota libre
const eventTags = e => [...(e.reasons || []), ...(e.note ? [e.note] : [])];
const eventText = e => eventTags(e).join(' · ');

function openSheet(type) {
  sheetFor = events[events.length - 1];
  $('sheet-title').textContent = type === 'pause' ? '⏸️ ¿Por qué paras?' : '▶️ ¿Algo que anotar al volver?';
  const chips = $('sheet-chips');
  chips.innerHTML = '';
  for (const r of reasons) {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = r;
    b.onclick = () => { sheetSel.has(r) ? sheetSel.delete(r) : sheetSel.add(r); b.classList.toggle('on', sheetSel.has(r)); updateSheetOk(); };
    chips.appendChild(b);
  }
  sheetSel.clear();
  $('sheet-input').value = '';
  updateSheetOk();
  $('sheet').hidden = false;
}
function sheetValue() {
  const note = $('sheet-input').value.trim();
  const v = { reasons: reasons.filter(r => sheetSel.has(r)) };
  if (note) v.note = note;
  return v;
}
function updateSheetOk() {
  const txt = eventText(sheetValue());
  $('sheet-ok').disabled = !txt;
  $('sheet-ok').textContent = txt ? `✅ Guardar · ${txt}` : '✅ Guardar';
}
function closeSheet() { $('sheet').hidden = true; sheetFor = null; }
function setReason(v) {
  if (sheetFor && eventText(v)) {
    delete sheetFor.reasons; delete sheetFor.note;
    if (v.reasons.length) sheetFor.reasons = v.reasons;
    if (v.note) sheetFor.note = v.note;
    save(K_EVENTS, events);
    toast(`Anotado: ${eventText(v)}`);
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
    $('stale-text').textContent = `La jornada del ${fmtLongDate.format(open.start).toLowerCase()} empezó a las ${clock(open.start)} y no se finalizó. Último registro: ${LABEL[open.events[open.events.length - 1].type].toLowerCase()} a las ${clock(lastT)}.`;
    const inp = $('stale-time');
    if (inp.dataset.for !== open.events[0].ts) {
      inp.innerHTML = timePickerHTML('', clock(lastT)); inp.dataset.for = open.events[0].ts; $('stale-error').textContent = '';
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
  const off = daysOff.has(todayK);
  let txt = nowOut ? (win ? `🌙 Fuera de horario · ${win.label}` : '🌙 Hoy es día libre')
                   : (win ? `🕘 Horario ${win.label}` : off ? '🏖️ Hoy es día libre' : '🏖️ Hoy no tienes horario');
  if (day && day.out >= 60000) txt += ` · ${hm(day.out)} fuera`;
  sch.textContent = txt;
  $('timer').textContent = hms(day ? day.work : 0);
  const exp = expectedMs(todayK);
  $('timer-sub').textContent = exp ? `Tiempo efectivo de ${hm(exp)} esperadas` : 'Tiempo efectivo';
  // Tiempo restante (informativo): puede llegar a 0 y seguir trabajando
  const rem = $('remaining');
  const left = exp - (day ? day.work : 0);
  rem.className = 'remaining';
  if (!exp) rem.hidden = true;
  else {
    rem.hidden = false;
    if (left > 0) {
      const leftTxt = hms(left + 999); // redondeo hacia arriba para no mostrar 0:00:00 antes de tiempo
      if (state === 'working') rem.innerHTML = `⏳ Quedan <b>${leftTxt}</b> · podrías parar a las <b>${clock(new Date(now.getTime() + left))}</b>`;
      else if (state === 'paused') rem.innerHTML = `⏳ Quedan <b>${leftTxt}</b> al volver`;
      else if (state === 'done') rem.innerHTML = `Te faltaron <b>${hm(left)}</b>`;
      else rem.innerHTML = `⏳ Hoy toca <b>${hm(exp)}</b>`;
    } else {
      rem.classList.add('met');
      rem.innerHTML = `✅ Jornada cumplida${-left >= 1000 ? ` · <b>+${hms(-left)}</b> extra` : ''}`;
    }
  }
  $('st-paused').textContent = hm(day ? day.paused : 0);
  $('st-pauses').textContent = day ? day.pauses : 0;
  $('st-start').textContent = day ? clock(day.start) : '—';

  const pi = $('pause-info');
  if (state === 'paused') {
    const p = events[events.length - 1], pt = new Date(p.ts);
    pi.hidden = false;
    pi.textContent = `En pausa desde ${clock(pt)} · ${human(now - pt)}${eventText(p) ? ' · ' + eventText(p) : ''}`;
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
      li.innerHTML = `<span class="t">${clock(new Date(e.ts))}</span><span>${ICON[e.type]} ${LABEL[e.type]}</span>${eventText(e) ? `<span class="r"></span>` : ''}`;
      if (eventText(e)) li.querySelector('.r').textContent = eventText(e);
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
let selectedDay = null; // día visible en Resumen (por defecto, hoy)

function dayCardHTML({ k, d, exp }, todayK) {
  const work = d ? d.work : 0, diff = work - exp;
  const live = k === todayK && (!d || d.open);
  const diffChip = exp || work ? `<span class="diff ${live ? 'live' : diff >= 0 ? 'pos' : 'neg'}">${live ? 'en curso' : signedHM(diff)}</span>` : '';
  const head = `<div class="day-head"><span class="day-name">${fmtShortDate.format(parseDay(k))}</span><span class="day-eff">${hm(work)}<small> / ${hm(exp)}</small></span></div>`;
  if (!d) {
    const what = exp ? 'Sin registros' : (daysOff.has(k) ? '🏖️ Día libre · sin registros' : 'Sin horario · sin registros');
    return `<div class="card day empty-day">${head}<div class="day-meta"><span>${what}</span>${diffChip}</div></div>`;
  }
  const reasons = Object.entries(d.reasonCount).map(([r, n]) => `<span>${escapeHTML(n > 1 ? `${r} ×${n}` : r)}</span>`).join('');
  return `<div class="card day">
      ${head}
      ${timelineHTML(d)}
      <div class="day-meta">
        <span>🕘 <b>${clock(d.start)}</b> → <b>${d.open ? 'en curso' : clock(d.end)}</b></span>
        <span>⏸️ <b>${hm(d.paused)}</b> pausado</span>
        <span><b>${d.pauses}</b> pausa${d.pauses === 1 ? '' : 's'}</span>
        ${diffChip}
      </div>
      <div class="day-sched">${schedLine(d)}</div>
      <div class="day-reasons">${reasons}</div>
    </div>`;
}

function renderSummary() {
  const now = new Date();
  const map = buildDays(now);
  const avg = $('avg'), box = $('days');
  const todayK = dayKey(now);
  if (!map.size) {
    avg.innerHTML = '';
    $('day-viewer').hidden = true;
    box.innerHTML = '<div class="empty">Aún no hay jornadas.<br>Empieza una desde la pestaña Hoy.</div>';
    return;
  }
  $('day-viewer').hidden = false;
  // Todos los días desde el primer registro hasta hoy: los trabajados, los laborables sin registros y hoy
  const all = [];
  for (let dt = parseDay([...map.keys()].sort()[0]); dayKey(dt) <= todayK; dt.setDate(dt.getDate() + 1)) {
    const k = dayKey(dt), d = map.get(k), exp = expectedMs(k);
    if (d || exp || k === todayK) all.push({ k, d, exp });
  }
  all.reverse(); // más reciente primero

  // Totales: el balance solo cuenta días cerrados (hoy entra cuando la jornada ha terminado)
  const counted = all.filter(x => x.k !== todayK || (x.d && !x.d.open));
  const totWork = counted.reduce((a, x) => a + (x.d ? x.d.work : 0), 0);
  const totExp = counted.reduce((a, x) => a + x.exp, 0);
  const bal = totWork - totExp;
  const days = all.filter(x => x.d).map(x => x.d);
  const closed = days.filter(d => !d.open);
  const mean = arr => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
  const card = (big, label, cls = '') => `<div class="card ${cls}"><div class="big">${big}</div><small>${label}</small></div>`;
  avg.innerHTML =
    card(hm(totWork), 'efectivo total') +
    card(hm(totExp), 'esperado total') +
    card(signedHM(bal), bal >= 0 ? 'balance · por encima de lo esperado' : 'balance · por debajo de lo esperado', 'wide ' + (bal >= 0 ? 'pos' : 'neg')) +
    card(closed.length ? hm(mean(closed.map(d => d.work))) : '—', 'efectivo medio / día') +
    card(closed.length ? hm(mean(closed.map(d => d.paused))) : '—', 'pausa media / día') +
    card(days.length ? fromMinutes(mean(days.map(d => minutesOfDay(d.start)))) : '—', 'inicio medio') +
    card(closed.length ? fromMinutes(mean(closed.map(d => minutesOfDay(d.end)))) : '—', 'fin medio');

  // Visor de un día
  if (!selectedDay || !all.some(x => x.k === selectedDay)) selectedDay = todayK;
  const idx = all.findIndex(x => x.k === selectedDay);
  $('day-prev').disabled = idx >= all.length - 1;
  $('day-next').disabled = idx <= 0;
  $('day-title').textContent = selectedDay === todayK ? 'Hoy' : fmtShortDate.format(parseDay(selectedDay));
  $('day-detail').innerHTML = dayCardHTML(all[idx], todayK);

  // Lista compacta de todos los días
  box.innerHTML = `<h2>Todos los días <small>(${days.length} trabajado${days.length === 1 ? '' : 's'})</small></h2>` + all.map(x => {
    const work = x.d ? x.d.work : 0, diff = work - x.exp;
    const live = x.k === todayK && (!x.d || x.d.open);
    const cls = live ? 'live' : (x.exp || work) ? (diff >= 0 ? 'pos' : 'neg') : 'live';
    const diffTxt = live ? 'en curso' : (x.exp || work) ? signedHM(diff) : '—';
    return `<button type="button" class="day-row${x.k === selectedDay ? ' sel' : ''}" data-day="${x.k}">
      <span class="dr-date">${fmtShortDate.format(parseDay(x.k))}${daysOff.has(x.k) ? ' 🏖️' : ''}</span>
      <span class="dr-work">${hm(work)}<small> / ${hm(x.exp)}</small></span>
      <span class="diff ${cls}">${diffTxt}</span>
    </button>`;
  }).join('');
  $('day-nav-keys').value = all.map(x => x.k).join(',');
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
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();

function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('cal-title').textContent = `${cap(MONTHS[m])} ${y}`;
  const grid = $('cal-grid');
  let html = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(x => `<span class="cal-h">${x}</span>`).join('');
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // lunes = 0
  html += '<span></span>'.repeat(lead);
  const todayK = dayKey(new Date()), days = new Date(y, m + 1, 0).getDate();
  for (let i = 1; i <= days; i++) {
    const k = dayKey(new Date(y, m, i));
    const cls = ['cal-d'];
    if (daysOff.has(k)) cls.push('off');
    else if (!schedule[new Date(y, m, i).getDay()]) cls.push('free');
    if (k === todayK) cls.push('today');
    html += `<button type="button" class="${cls.join(' ')}" data-day="${k}">${i}</button>`;
  }
  grid.innerHTML = html;
  const yr = String(new Date().getFullYear());
  const nYear = [...daysOff].filter(k => k.startsWith(yr)).length;
  const nMonth = [...daysOff].filter(k => k.startsWith(`${y}-${pad(m + 1)}`)).length;
  $('cal-count').textContent = `${nMonth} en este mes · ${nYear} día${nYear === 1 ? '' : 's'} libre${nYear === 1 ? '' : 's'} en ${yr}`;
}

const BREAK_OPTIONS = [0, 15, 30, 45, 60, 75, 90, 105, 120, 150, 180];
const minutesBetween = (a, b) => { const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number); return (bh * 60 + bm) - (ah * 60 + am); };

function renderSchedule() {
  const box = $('schedule-edit');
  box.innerHTML = '';
  for (const wd of WEEK_ORDER) {
    const sch = schedule[wd];
    const row = document.createElement('div');
    row.className = 'sch-row' + (sch ? '' : ' off');
    row.innerHTML = `
      <button type="button" class="sch-day">${WEEK_NAMES[wd]}<small>${sch ? 'laborable' : 'libre'}</small></button>
      ${timePickerHTML('sch-from', sch ? sch[0] : '09:00', 5, !sch)}
      <span class="sch-sep">→</span>
      ${timePickerHTML('sch-to', sch ? sch[1] : '18:00', 5, !sch)}
      <label class="sch-break">☕ Descanso no computable
        <select class="sch-brk"${sch ? '' : ' disabled'}>${BREAK_OPTIONS.map(m => `<option value="${m}"${m === ((sch && sch[2]) || 0) ? ' selected' : ''}>${m ? hm(m * 60000) : 'ninguno'}</option>`).join('')}</select>
        <span class="sch-exp">${sch ? `→ ${hm(Math.max(0, minutesBetween(sch[0], sch[1]) - (sch[2] || 0)) * 60000)} esperadas` : ''}</span>
      </label>`;
    row.querySelector('.sch-day').onclick = () => {
      schedule[wd] = sch ? null : DEFAULT_SCHEDULE[1].slice();
      save(K_SCHEDULE, schedule); renderSchedule(); renderCalendar();
    };
    const onChange = () => {
      const f = tpGet(row.querySelector('.sch-from')), t = tpGet(row.querySelector('.sch-to'));
      const brk = Number(row.querySelector('.sch-brk').value);
      if (!(f < t)) { toast('El inicio tiene que ser antes del fin'); return; }
      if (brk >= minutesBetween(f, t)) { toast('El descanso no puede ocupar toda la franja'); return; }
      schedule[wd] = brk ? [f, t, brk] : [f, t];
      save(K_SCHEDULE, schedule);
      row.querySelector('.sch-exp').textContent = `→ ${hm((minutesBetween(f, t) - brk) * 60000)} esperadas`;
      toast(`${WEEK_NAMES[wd]}: ${f}–${t}${brk ? ` · descanso ${hm(brk * 60000)}` : ''}`);
    };
    row.querySelector('.sch-from').onchange = onChange;
    row.querySelector('.sch-to').onchange = onChange;
    row.querySelector('.sch-brk').onchange = onChange;
    box.appendChild(row);
  }
}

function renderSettings() {
  renderSchedule();
  renderCalendar();
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
  // Todos los días desde el primer registro hasta hoy (también los que no se trabajó),
  // para que el esperado vs. efectivo cuadre.
  const map = buildDays();
  const keys = [...map.keys()].sort();
  const rows = [['fecha', 'dia_semana', 'tipo_dia', 'horario', 'descanso_min', 'esperado_hhmm', 'esperado_min', 'efectivo_hhmm', 'efectivo_min', 'pausado_hhmm', 'pausado_min', 'diferencia_hhmm', 'diferencia_min', 'inicio', 'fin', 'pausas', 'sesiones', 'motivos', 'antes_min', 'despues_min', 'fuera_horario_min']];
  if (keys.length) {
    const today = dayKey(new Date());
    for (let dt = parseDay(keys[0]); dayKey(dt) <= today; dt.setDate(dt.getDate() + 1)) {
      const k = dayKey(dt), d = map.get(k), win = scheduleWindow(k), exp = expectedMs(k);
      const work = d ? d.work : 0, paused = d ? d.paused : 0;
      rows.push([
        ddmmyyyy(dt), fmtWeekday.format(dt), dayType(k), win ? win.label : '', win ? win.brk : 0,
        hm(exp), Math.round(exp / 60000), hm(work), Math.round(work / 60000), hm(paused), Math.round(paused / 60000),
        signedHM(work - exp), Math.round(work / 60000) - Math.round(exp / 60000),
        d ? clock(d.start) : '', d && !d.open ? clock(d.end) : '', d ? d.pauses : 0, d ? d.sessions.length : 0,
        d ? Object.entries(d.reasonCount).map(([r, n]) => n > 1 ? `${r} x${n}` : r).join(' | ') : '',
        d ? Math.round(d.early / 60000) : 0, d ? Math.round(d.late / 60000) : 0, d ? Math.round(d.out / 60000) : 0,
      ]);
    }
  }
  deliver(`busy_resumen_${stamp()}.csv`, csv(rows), 'text/csv');
}

function exportEvents() {
  const rows = [['fecha', 'hora', 'evento', 'motivos', 'nota', 'timestamp']];
  const sessions = buildSessions();
  for (const s of sessions) for (const e of s.events) {
    const t = new Date(e.ts);
    rows.push([ddmmyyyy(parseDay(s.day)), `${clock(t)}:${pad(t.getSeconds())}`, LABEL[e.type], (e.reasons || []).join(' | '), e.note || '', e.ts]);
  }
  deliver(`busy_eventos_${stamp()}.csv`, csv(rows), 'text/csv');
}

function exportJSON() {
  const data = { app: 'busy', exportedAt: new Date().toISOString(), timezoneOffsetMin: -new Date().getTimezoneOffset(), reasons, schedule, daysOff: [...daysOff].sort(), events };
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
  if (v === 'summary') selectedDay = null; // al entrar en Resumen, se muestra hoy
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
$('sheet-form').addEventListener('submit', e => { e.preventDefault(); setReason(sheetValue()); });
$('sheet-input').addEventListener('input', updateSheetOk);

$('stale-close').addEventListener('click', () => {
  const open = currentSession();
  if (!open) return render();
  const [h, m] = tpGet($('stale-time')).split(':').map(Number);
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

$('cal-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  const k = b.dataset.day;
  daysOff.has(k) ? daysOff.delete(k) : daysOff.add(k);
  saveDaysOff();
  renderCalendar();
});
$('cal-prev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('cal-next').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });

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

// Navegación del visor de días en Resumen
function stepDay(delta) {
  const keys = $('day-nav-keys').value.split(','); // más reciente primero
  const i = keys.indexOf(selectedDay) - delta;
  if (i >= 0 && i < keys.length) { selectedDay = keys[i]; renderSummary(); }
}
$('day-prev').addEventListener('click', () => stepDay(-1));
$('day-next').addEventListener('click', () => stepDay(1));
$('days').addEventListener('click', e => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  selectedDay = b.dataset.day;
  renderSummary();
  $('day-viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Borrar: solo registros o todo (valores por defecto)
$('reset').addEventListener('click', () => { $('reset').hidden = true; $('reset-choice').hidden = false; });
$('reset-cancel').addEventListener('click', () => { $('reset').hidden = false; $('reset-choice').hidden = true; });
$('reset-events').addEventListener('click', () => {
  events = [];
  save(K_EVENTS, events);
  $('reset').hidden = false; $('reset-choice').hidden = true;
  toast('Registros borrados');
  render();
});
$('reset-all').addEventListener('click', () => {
  try { Object.keys(localStorage).filter(k => k.startsWith('busy.')).forEach(k => localStorage.removeItem(k)); } catch {}
  location.reload();
});

// Refresco del cronómetro
setInterval(() => { if (view === 'today' && $('sheet').hidden) renderToday(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { events = load(K_EVENTS, []); render(); } });

applyTheme();
show('today');

// ---------- Sugerir instalación (Chrome Android) ----------
let installPrompt = null;
const K_INSTALL_DISMISSED = 'busy.installDismissed';
function updateInstallUI() {
  const can = !!installPrompt;
  $('install').hidden = !can || load(K_INSTALL_DISMISSED, false);
  $('install-settings-wrap').hidden = !can;
}
async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === 'accepted') installPrompt = null;
  updateInstallUI();
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; updateInstallUI(); });
window.addEventListener('appinstalled', () => { installPrompt = null; updateInstallUI(); toast('✅ Busy instalada'); });
$('install-btn').addEventListener('click', doInstall);
$('install-settings').addEventListener('click', doInstall);
$('install-x').addEventListener('click', () => { save(K_INSTALL_DISMISSED, true); updateInstallUI(); toast('Puedes instalarla luego desde Ajustes'); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
