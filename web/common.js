// Utilidades compartidas por todas las pantallas.
export const state = { config: null };

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const pin = localStorage.getItem('adminPin');
  if (pin) headers['X-Admin-Pin'] = pin;
  const code = localStorage.getItem('accessCode');
  if (code) headers['X-Access-Code'] = code;

  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Sin conexion con el servidor de caja');
  }
  const data = await response.json().catch(() => ({ ok: false, error: 'Respuesta invalida del servidor' }));
  if (!response.ok || data.ok === false) {
    // sin codigo (o lo cambiaron en Ajustes): a la pantalla de ingreso, volviendo aqui despues
    if (data.auth === 'code') goToLogin();
    const error = new Error(data.error || `Error ${response.status}`);
    error.status = response.status;
    error.auth = data.auth;
    throw error;
  }
  return data;
}

export function goToLogin() {
  localStorage.removeItem('accessCode');
  const next = location.pathname + location.search;
  location.href = `/login.html?next=${encodeURIComponent(next)}`;
}

const LEVELS = { stand: 1, cashier: 2, admin: 3 };

export async function loadConfig() {
  state.config = await api('/api/bootstrap');
  return state.config;
}

/**
 * Deja entrar a la pantalla solo si el codigo alcanza (el servidor igual lo
 * valida en cada accion). Un stand que abre la caja termina en su pantalla.
 */
export function requireRole(role) {
  const current = state.config?.role;
  if (current && LEVELS[current] >= LEVELS[role]) return true;
  location.replace(current === 'stand' ? '/stand.html' : '/login.html');
  return false;
}

export function logout() {
  localStorage.removeItem('accessCode');
  localStorage.removeItem('adminPin');
  location.href = '/login.html';
}

export function money(amount) {
  const cur = state.config?.currency || { symbol: '$', decimals: 0, thousandsSep: '.', decimalSep: ',' };
  const decimals = Number(cur.decimals || 0);
  const negative = amount < 0;
  const fixed = Math.abs(Number(amount) || 0).toFixed(decimals);
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, cur.thousandsSep ?? '.');
  return `${negative ? '-' : ''}${cur.symbol ?? '$'}${dec ? grouped + (cur.decimalSep ?? ',') + dec : grouped}`;
}

export function parseAmount(text) {
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  return digits ? Number.parseInt(digits, 10) : 0;
}

export function humanDate(value) {
  if (!value || value.length < 10) return value || '';
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

export function time(value) {
  return value ? value.slice(11, 16) : '';
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function toast(title, { detail = '', type = '', timeout = 3500 } = {}) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast ${type}` }, [
    el('div', { class: 'title', text: title }),
    detail ? el('div', { class: 'detail', text: detail }) : null,
  ]);
  host.append(node);
  setTimeout(() => node.remove(), timeout);
}

export function openModal(content, { onClose } = {}) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal' }, content);
  backdrop.append(modal);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  };
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { close, modal };
}

export function confirmDialog(title, message, { danger = false, confirmText = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const { close } = openModal([
      el('h2', { text: title }),
      el('p', { class: 'sub', text: message }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn ghost', onclick: () => { decided = true; close(); resolve(false); } }, ['Cancelar']),
        el('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: () => { decided = true; close(); resolve(true); } }, [confirmText]),
      ]),
    ], { onClose: () => { if (!decided) resolve(false); } });
  });
}

/** Barra superior compartida. `current` marca la pestana activa. */
export function renderTopbar(current) {
  const host = document.getElementById('topbar');
  if (!host) return;
  const cashier = getCashier();
  const nav = [
    ['/', 'Caja', 'caja'],
    ['/pedidos.html', 'Pedidos', 'pedidos'],
    ['/stand.html', 'Stand', 'stand'],
    ['/cierre.html', 'Cierre', 'cierre'],
    ['/admin.html', 'Ajustes', 'admin'],
  ];
  // con codigos, quien entro con uno puede salir (por ejemplo para prestar el celular)
  const canLogout = state.config?.accessEnabled && localStorage.getItem('accessCode');
  host.className = 'topbar';
  host.replaceChildren(
    el('div', { class: 'brand', text: state.config?.business?.name || 'Caja' }),
    el('div', { class: 'cashier' }, [
      el('span', { text: 'Caja:' }),
      el('input', {
        value: cashier,
        title: 'Nombre de esta caja (se guarda en este equipo)',
        oninput: (event) => localStorage.setItem('cashier', event.target.value),
      }),
    ]),
    el('div', { class: 'cashier', id: 'printer-status', title: 'Estado de la impresora' }, [
      el('span', { class: 'printer-dot', id: 'printer-dot' }),
      el('span', { id: 'printer-label', text: 'Impresora' }),
    ]),
    el('nav', {}, [
      ...nav.map(([href, label, key]) => el('a', { href, class: key === current ? 'active' : '', text: label })),
      canLogout ? el('a', { href: '#', text: 'Salir', onclick: (event) => { event.preventDefault(); logout(); } }) : null,
    ]),
  );
  refreshPrinterStatus();
}

export function getCashier() {
  return localStorage.getItem('cashier') || 'Caja 1';
}

export async function refreshPrinterStatus() {
  const dot = document.getElementById('printer-dot');
  const label = document.getElementById('printer-label');
  if (!dot) return;
  try {
    const { status } = await api('/api/printer/status');
    const disabled = status.mode === 'none';
    dot.className = `printer-dot ${disabled ? '' : status.reachable ? 'ok' : 'bad'}`;
    label.textContent = disabled ? 'Sin impresora' : status.reachable ? 'Impresora lista' : 'Impresora sin conexion';
    document.getElementById('printer-status').title = status.description + ' - ' + status.message;
  } catch {
    dot.className = 'printer-dot bad';
    label.textContent = 'Sin servidor';
  }
}

/** Ventana de impresion desde el navegador (respaldo si falla la impresora). */
export function printTextInBrowser(text, title = 'Ticket') {
  const win = window.open('', '_blank', 'width=420,height=640');
  if (!win) {
    toast('El navegador bloqueo la ventana de impresion', { type: 'bad' });
    return;
  }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      @page { size: 58mm auto; margin: 2mm; }
      body { margin: 0; font-family: "Courier New", monospace; font-size: 11px; line-height: 1.3; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
    </style></head><body><pre></pre></body></html>`);
  win.document.querySelector('pre').textContent = text;
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}
