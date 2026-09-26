// Pantalla del stand: pedidos pendientes de un solo stand y marcar entregas.
// Pensada para el celular o tablet de cada stand, conectado a la red de la caja.
import { api, loadConfig, state, el, toast, confirmDialog, time } from './common.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'standStationId';
const POLL_MS = 3000;
const LATE_MINUTES = 10;
const UNDO_MS = 5000;
const DELIVERED_SHOWN = 15;

let station = null; // { key, id, name }: key es el id como texto o 'none'
let queue = null; // ultima respuesta del servidor
let clockSkew = 0; // diferencia entre el reloj del celular y el del servidor
let timer = null;
let pollSeq = 0; // correlativo de consultas
let appliedSeq = 0; // ultima consulta dibujada: una respuesta atrasada no pisa a una nueva
let loaded = false;
let deliveredSignature = '';
let undoTimer = null;
let undoFor = null;

const known = new Set(); // pendientes ya vistos: los nuevos se destacan
const cards = new Map(); // tarjetas en pantalla por pedido, se reutilizan entre consultas
const inflight = new Map(); // pedido -> promesa del cambio en curso (evita doble envio)
// Cambios hechos aqui que el servidor aun no refleja: { state, entry, settleAfter }.
// Se descartan cuando llega una consulta iniciada despues de confirmar el cambio.
const overrides = new Map();

init().catch((err) => toast('Error al cargar', { detail: err.message, type: 'bad' }));

async function init() {
  await loadConfig();
  $('change').addEventListener('click', changeStation);
  document.addEventListener('visibilitychange', () => {
    if (!station) return;
    if (document.hidden) stopPolling();
    else poll();
  });

  // ?station=<id> permite dejar un enlace por stand; se guarda en el equipo
  const fromUrl = new URLSearchParams(location.search).get('station');
  if (fromUrl) localStorage.setItem(STORAGE_KEY, fromUrl);
  const chosen = findStation(localStorage.getItem(STORAGE_KEY));
  if (chosen) {
    start(chosen);
    return;
  }
  if (fromUrl) toast('Ese stand no existe', { detail: 'Elige tu stand de la lista.', type: 'bad' });
  showPicker();
}

// ------------------------------------------------------------ elegir stand

function stationOptions() {
  const stations = [...state.config.stations]
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((s) => ({ key: String(s.id), id: s.id, name: s.name, active: s.active !== false }));
  return [...stations, { key: 'none', id: null, name: 'RETIRO', label: 'Retiro (sin stand)', active: true }];
}

function findStation(key) {
  return key ? stationOptions().find((option) => option.key === key) || null : null;
}

function showPicker() {
  stopPolling();
  hideUndo();
  station = null;
  document.title = 'Stand';
  $('stand-name').textContent = 'Elige tu stand';
  $('stand-meta').hidden = true;
  $('change').hidden = true;
  $('queue').hidden = true;
  $('picker').hidden = false;
  $('picker-list').replaceChildren(...stationOptions().filter((option) => option.active).map((option) => el('button', {
    class: 'btn ghost block stand-choice',
    onclick: () => {
      localStorage.setItem(STORAGE_KEY, option.key);
      start(option);
    },
  }, [option.label || option.name])));
}

function changeStation() {
  localStorage.removeItem(STORAGE_KEY);
  // sin esto, al recargar se volveria a elegir el stand del enlace
  if (location.search) history.replaceState(null, '', location.pathname);
  showPicker();
}

function start(option) {
  station = option;
  queue = null;
  loaded = false;
  deliveredSignature = '';
  known.clear();
  cards.clear();
  overrides.clear();
  inflight.clear();
  $('pending').replaceChildren();
  $('delivered').replaceChildren();
  $('empty').hidden = true;
  document.title = `Stand ${option.name}`;
  $('stand-name').textContent = option.name;
  $('pending-count').textContent = '';
  $('stand-meta').hidden = false;
  $('change').hidden = false;
  $('picker').hidden = true;
  $('queue').hidden = false;
  setConnection(null);
  poll();
}

// --------------------------------------------------------------- consultas

function stopPolling() {
  clearTimeout(timer);
  timer = null;
}

async function poll() {
  stopPolling();
  const current = station;
  const seq = ++pollSeq;
  try {
    const data = await api(`/api/stations/${current.key}/queue`);
    if (station !== current || seq < appliedSeq) return;
    appliedSeq = seq;
    queue = data;
    clockSkew = Date.now() - (parseTime(data.now) || Date.now());
    for (const [id, override] of overrides) {
      if (seq > override.settleAfter) overrides.delete(id);
    }
    setConnection(true);
    render();
  } catch (err) {
    if (station !== current) return;
    if (err.status === 404) {
      toast('Este stand ya no existe', { detail: 'Elige tu stand de nuevo.', type: 'bad' });
      changeStation();
      return;
    }
    setConnection(false);
  }
  // solo la consulta mas reciente agenda la siguiente: nunca quedan dos ciclos
  if (station === current && seq === pollSeq && !document.hidden) timer = setTimeout(poll, POLL_MS);
}

function setConnection(ok) {
  $('conn').className = `conn ${ok === null ? '' : ok ? 'ok' : 'bad'}`;
  $('conn-label').textContent = ok === null ? 'Conectando' : ok ? 'En linea' : 'Sin conexion';
}

// ----------------------------------------------------------------- dibujo

/** Lo que dice el servidor mas los cambios de este equipo que aun no confirma. */
function view() {
  const pending = queue.pending.filter((entry) => !overrides.has(entry.id));
  const delivered = queue.delivered.filter((entry) => !overrides.has(entry.id));
  for (const override of overrides.values()) {
    (override.state === 'pending' ? pending : delivered).push(override.entry);
  }
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.code.localeCompare(b.code));
  delivered.sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
  return { pending, delivered: delivered.slice(0, DELIVERED_SHOWN) };
}

function render() {
  if (!queue) return;
  const { pending, delivered } = view();
  $('pending-count').textContent = pending.length === 1 ? '1 pendiente' : `${pending.length} pendientes`;
  $('empty').hidden = pending.length > 0;
  renderPending(pending);
  renderDelivered(delivered);
  loaded = true;
}

// Reutiliza las tarjetas existentes: no parpadea ni pierde la posicion del scroll.
function renderPending(pending) {
  const ids = new Set(pending.map((entry) => entry.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    card.remove();
    cards.delete(id);
  }
  const list = $('pending');
  pending.forEach((entry, index) => {
    let card = cards.get(entry.id);
    if (!card) {
      card = renderCard(entry);
      cards.set(entry.id, card);
      if (loaded && !known.has(entry.id)) announce(card);
    }
    known.add(entry.id);
    updateElapsed(card, entry);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  });
}

function renderCard(entry) {
  return el('article', { class: 'stand-card' }, [
    el('div', { class: 'stand-card-head' }, [
      el('span', { class: 'stand-code', text: entry.code }),
      el('span', { class: 'stand-elapsed' }),
    ]),
    el('ul', { class: 'stand-items' }, entry.items.map((item) => el('li', {}, [
      el('div', { class: 'stand-item' }, [el('strong', { text: `${item.qty}x` }), ` ${item.name}`]),
      item.note ? el('div', { class: 'stand-note', text: item.note }) : null,
    ]))),
    el('button', { class: 'btn ok block stand-deliver', onclick: () => deliver(entry) }, ['Entregado']),
  ]);
}

function updateElapsed(card, entry) {
  const minutes = Math.max(0, Math.floor((Date.now() - clockSkew - parseTime(entry.createdAt)) / 60000)) || 0;
  card.querySelector('.stand-elapsed').textContent = elapsedLabel(minutes);
  card.classList.toggle('late', minutes > LATE_MINUTES);
}

function elapsedLabel(minutes) {
  if (minutes < 1) return 'recien';
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function announce(card) {
  card.classList.add('is-new');
  setTimeout(() => card.classList.remove('is-new'), 2500);
  navigator.vibrate?.(200);
}

function renderDelivered(delivered) {
  const signature = delivered.map((entry) => `${entry.id}@${entry.deliveredAt}`).join(',');
  if (signature === deliveredSignature) return;
  deliveredSignature = signature;
  $('delivered-count').textContent = String(delivered.length);
  $('delivered').replaceChildren(...(delivered.length
    ? delivered.map((entry) => el('button', { class: 'stand-done', title: 'Volver a pendiente', onclick: () => undeliver(entry) }, [
      el('span', { class: 'stand-done-code', text: entry.code }),
      el('span', { class: 'stand-done-items', text: entry.items.map(itemText).join(', ') }),
      el('span', { class: 'stand-done-time', text: time(entry.deliveredAt) }),
    ]))
    : [el('p', { class: 'muted', text: 'Todavia no hay entregas.' })]));
}

function itemText(item) {
  return `${item.qty}x ${item.name}${item.note ? ` (${item.note})` : ''}`;
}

// ---------------------------------------------------------------- entregas

function deliver(entry) {
  if (inflight.has(entry.id)) return;
  showUndo(entry);
  change(entry, true).then((ok) => {
    if (!ok && undoFor === entry.id) hideUndo();
  });
}

async function undo(entry) {
  hideUndo();
  // si la entrega sigue en camino se espera; si fallo, la tarjeta ya volvio sola
  if (await inflight.get(entry.id) === false) return;
  change(entry, false);
}

async function undeliver(entry) {
  if (inflight.has(entry.id)) return;
  const ok = await confirmDialog('Volver a pendiente', `El pedido ${entry.code} volvera a la lista de pendientes.`, { confirmText: 'Volver a pendiente' });
  if (ok) change(entry, false);
}

function change(entry, delivered) {
  const promise = send(entry, delivered).finally(() => inflight.delete(entry.id));
  inflight.set(entry.id, promise);
  return promise;
}

// Cambio optimista: la pantalla responde al toque aunque la red este lenta.
async function send(entry, delivered) {
  const current = station;
  const { deliveredAt, ...pendingEntry } = entry;
  const previous = overrides.get(entry.id);
  overrides.set(entry.id, {
    state: delivered ? 'delivered' : 'pending',
    entry: delivered ? { ...pendingEntry, deliveredAt: serverNow() } : pendingEntry,
    settleAfter: Infinity,
  });
  render();
  try {
    await api(`/api/orders/${entry.id}/deliver`, { method: 'POST', body: { stationId: current.id, delivered } });
    const override = overrides.get(entry.id);
    if (override) override.settleAfter = pollSeq;
    return true;
  } catch (err) {
    if (station !== current) return false;
    if (previous) overrides.set(entry.id, previous);
    else overrides.delete(entry.id);
    render();
    toast(delivered ? `No se pudo entregar el ${entry.code}` : `No se pudo devolver el ${entry.code}`, { detail: err.message, type: 'bad' });
    return false;
  }
}

function showUndo(entry) {
  clearTimeout(undoTimer);
  undoFor = entry.id;
  $('undo-text').textContent = `Pedido ${entry.code} entregado`;
  $('undo').onclick = () => undo(entry);
  $('undo-bar').hidden = false;
  undoTimer = setTimeout(hideUndo, UNDO_MS);
}

function hideUndo() {
  clearTimeout(undoTimer);
  undoFor = null;
  $('undo-bar').hidden = true;
}

// ------------------------------------------------------------------- horas

/** Las horas del servidor vienen como 'YYYY-MM-DD HH:MM:SS' en hora local. */
function parseTime(value) {
  return new Date(String(value || '').replace(' ', 'T')).getTime();
}

function serverNow() {
  const d = new Date(Date.now() - clockSkew);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
