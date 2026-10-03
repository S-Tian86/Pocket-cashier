// Ajustes: catalogo de productos, stands, datos del negocio e impresora.
import { api, loadConfig, requireRole, state, money, el, toast, openModal, confirmDialog, renderTopbar, refreshPrinterStatus } from './common.js';

const $ = (id) => document.getElementById(id);
let settings = null;

init().catch((err) => toast('Error al cargar', { detail: err.message, type: 'bad' }));

async function init() {
  await loadConfig();
  if (!requireRole('cashier')) return;
  renderTopbar('admin');
  if (!(await ensurePin())) return;
  renderCatalog();
  fillSettings();
  wire();
}

/**
 * Carga la configuracion completa; si hay PIN y el guardado no sirve, lo pide.
 * Se carga siempre, haya PIN o no: el formulario de la impresora se llena con esto y,
 * si quedara vacio, al guardar borraria el comando, la IP y el dispositivo.
 */
async function ensurePin() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      settings = (await api('/api/settings')).settings;
      return true;
    } catch (err) {
      if (err.status !== 401 || err.auth !== 'pin') throw err;
      // con codigos y sin PIN, Ajustes solo se abre en el PC de la caja: no tiene sentido pedirlo
      if (!state.config.requiresPin) {
        document.querySelector('main').replaceChildren(el('div', { class: 'card' }, [
          el('h2', { text: 'Ajustes solo desde el PC de la caja' }),
          el('p', { class: 'muted', text: 'Para abrirlos desde otro equipo, define un PIN de administrador en Ajustes > Seguridad, en el PC de la impresora.' }),
        ]));
        return false;
      }
      const pin = window.prompt('PIN de administrador:');
      if (pin === null) { location.href = '/'; return false; }
      localStorage.setItem('adminPin', pin);
    }
  }
  toast('PIN incorrecto', { type: 'bad' });
  location.href = '/';
  return false;
}

function wire() {
  $('p-add').addEventListener('click', addProduct);
  $('p-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('p-price').focus(); });
  $('p-price').addEventListener('keydown', (event) => { if (event.key === 'Enter') addProduct(); });
  $('s-add').addEventListener('click', addStation);
  $('s-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') addStation(); });
  $('save-business').addEventListener('click', saveBusiness);
  $('save-printer').addEventListener('click', savePrinter);
  $('save-security').addEventListener('click', saveSecurity);
  $('test-printer').addEventListener('click', testPrinter);
  $('check-printer').addEventListener('click', checkPrinter);
  $('pr-mode').addEventListener('change', togglePrinterRows);
  $('gen-cashier').addEventListener('click', () => { $('code-cashier').value = randomCode(); });
  $('gen-stand').addEventListener('click', () => { $('code-stand').value = randomCode(); });
  $('save-access').addEventListener('click', saveAccess);
  $('print-cashier').addEventListener('click', () => printAccess('cashier'));
  $('print-stand').addEventListener('click', () => printAccess('stand'));
  $('promo-part-add').addEventListener('click', addPromoPart);
  $('promo-part-qty').addEventListener('keydown', (event) => { if (event.key === 'Enter') addPromoPart(); });
  $('promo-save').addEventListener('click', savePromo);
  $('promo-cancel').addEventListener('click', resetPromoForm);
}

// ------------------------------------------------------------------ catalogo

async function reload() {
  await loadConfig();
  renderCatalog();
}

function isPromo(product) {
  return Array.isArray(product.components) && product.components.length > 0;
}

function productName(id) {
  return state.config.products.find((product) => product.id === id)?.name || '?';
}

function renderCatalog() {
  const stations = state.config.stations;
  const all = [...state.config.products].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  const products = all.filter((product) => !isPromo(product));

  $('p-station').replaceChildren(
    ...stations.map((station) => el('option', { value: station.id, text: station.name })),
    el('option', { value: '', text: 'Sin stand' }),
  );
  $('categorias').replaceChildren(...[...new Set(all.map((p) => p.category).filter(Boolean))].map((c) => el('option', { value: c })));

  $('products').replaceChildren(...products.map((product) => el('tr', { class: product.active === false ? 'void' : '' }, [
    el('td', {}, [editable(product, 'name', 'text')]),
    el('td', { class: 'num' }, [editable(product, 'price', 'number')]),
    el('td', {}, [editable(product, 'category', 'text')]),
    el('td', {}, [stationSelect(product)]),
    el('td', { class: 'num' }, [stockCell(product)]),
    el('td', {}, [el('button', {
      class: `tag ${product.active === false ? 'bad' : 'ok'}`,
      style: 'cursor:pointer;border:none',
      onclick: () => updateProduct(product, { active: product.active === false }),
    }, [product.active === false ? 'Oculto' : 'Activo'])]),
    el('td', {}, [el('button', { class: 'btn danger small', onclick: () => removeProduct(product) }, ['Borrar'])]),
  ])));

  renderPromos(all.filter(isPromo), products);

  $('stations').replaceChildren(...stations.map((station) => {
    const count = products.filter((product) => product.stationId === station.id).length;
    return el('tr', {}, [
      el('td', {}, [el('input', {
        type: 'color',
        value: station.color || '#9aa5b5',
        title: 'Color con que se pinta en caja',
        style: 'width:44px;height:36px;padding:2px;border:1px solid var(--line);border-radius:8px;background:none;cursor:pointer',
        onchange: (event) => saveStation({ ...station, color: event.target.value }),
      })]),
      el('td', {}, [el('input', {
        value: station.name,
        style: 'width:100%',
        onchange: (event) => saveStation({ ...station, name: event.target.value }),
      })]),
      el('td', { text: `${count} productos` }),
      el('td', {}, [stationCheck(station, 'printReceipt', 'Venta')]),
      el('td', {}, [stationCheck(station, 'printTicket', 'Retiro')]),
      el('td', {}, [el('button', {
        class: `tag ${station.active === false ? 'bad' : 'ok'}`,
        style: 'cursor:pointer;border:none',
        onclick: () => saveStation({ ...station, active: station.active === false }),
      }, [station.active === false ? 'Oculto' : 'Activo'])]),
      el('td', {}, [el('button', { class: 'btn danger small', onclick: () => removeStation(station) }, ['Borrar'])]),
    ]);
  }));
}

/** Ticket de venta / de retiro por stand: ej. las entradas se cobran para la cuadratura pero no imprimen nada. */
function stationCheck(station, field, label) {
  return el('label', { style: 'display:flex;gap:6px;align-items:center;cursor:pointer;white-space:nowrap' }, [
    el('input', {
      type: 'checkbox',
      checked: station[field] !== false,
      onchange: (event) => saveStation({ ...station, [field]: event.target.checked }),
    }),
    label,
  ]);
}

function editable(product, field, type) {
  return el('input', {
    value: product[field] ?? '',
    inputmode: type === 'number' ? 'numeric' : undefined,
    style: `width:100%${type === 'number' ? ';text-align:right' : ''}`,
    onchange: (event) => updateProduct(product, { [field]: event.target.value }),
  });
}

/** Stock: el numero fija la cantidad exacta (vacio = sin limite); Reponer suma sobre lo que haya. */
function stockCell(product) {
  const tracked = product.stock !== null && product.stock !== undefined;
  return el('div', { style: 'display:flex;gap:6px;align-items:center;justify-content:flex-end' }, [
    el('input', {
      value: tracked ? product.stock : '',
      placeholder: 'Sin limite',
      inputmode: 'numeric',
      style: `width:80px;text-align:right${tracked && product.stock <= 5 ? ';color:var(--danger);font-weight:700' : ''}`,
      onchange: (event) => adjustStock(product, { set: event.target.value.trim() }),
    }),
    tracked ? el('button', { class: 'btn ghost small', onclick: () => restock(product) }, ['Reponer']) : null,
  ]);
}

async function adjustStock(product, body) {
  try {
    await api(`/api/products/${product.id}/stock`, { method: 'POST', body });
    await reload();
  } catch (err) {
    toast('No se pudo cambiar el stock', { detail: err.message, type: 'bad' });
    await reload();
  }
}

function restock(product) {
  const input = el('input', { inputmode: 'numeric', placeholder: 'Ej: 20' });
  const save = async () => {
    const add = Number.parseInt(input.value, 10);
    if (!add) { input.focus(); return; }
    close();
    await adjustStock(product, { add });
    toast(`${product.name}: ${add > 0 ? '+' : ''}${add}`, { type: 'ok' });
  };
  const { close } = openModal([
    el('h2', { text: `Reponer ${product.name}` }),
    el('p', { class: 'sub', text: `Quedan ${product.stock}. Escribe cuantas unidades llegaron (o un numero negativo para descontar mermas).` }),
    el('div', { class: 'field' }, [input]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn ghost', onclick: () => close() }, ['Cancelar']),
      el('button', { class: 'btn', onclick: save }, ['Sumar al stock']),
    ]),
  ]);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
  setTimeout(() => input.focus(), 30);
}

// -------------------------------------------------------------------- promos

let promoParts = []; // [{ productId, qty }] de la promo que se esta armando
let editingPromo = null;

function renderPromos(promos, products) {
  const current = $('promo-part').value;
  $('promo-part').replaceChildren(...products.filter((product) => product.active !== false)
    .map((product) => el('option', { value: product.id, text: `${product.name} (${money(product.price)})` })));
  if (current) $('promo-part').value = current;
  renderPromoParts();

  $('promos').replaceChildren(...promos.map((promo) => {
    const regular = promo.components.reduce((sum, part) => sum + (state.config.products.find((p) => p.id === part.productId)?.price || 0) * part.qty, 0);
    const left = promoAvailable(promo);
    return el('tr', { class: promo.active === false ? 'void' : '' }, [
      el('td', {}, [editable(promo, 'name', 'text')]),
      el('td', { class: 'num' }, [editable(promo, 'price', 'number')]),
      el('td', { text: promo.components.map((part) => `${part.qty} ${productName(part.productId)}`).join(' + ') }),
      el('td', { class: 'num', text: money(regular) }),
      el('td', { class: 'num', text: left === null ? 'Sin limite' : String(left) }),
      el('td', {}, [el('button', {
        class: `tag ${promo.active === false ? 'bad' : 'ok'}`,
        style: 'cursor:pointer;border:none',
        onclick: () => updateProduct(promo, { active: promo.active === false }),
      }, [promo.active === false ? 'Oculto' : 'Activo'])]),
      el('td', {}, [el('div', { class: 'row-actions' }, [
        el('button', { class: 'btn ghost small', onclick: () => editPromo(promo) }, ['Editar']),
        el('button', { class: 'btn danger small', onclick: () => removeProduct(promo) }, ['Borrar']),
      ])]),
    ]);
  }));
  if (!promos.length) {
    $('promos').replaceChildren(el('tr', {}, [el('td', { colspan: 7, class: 'muted', text: 'Todavia no hay promos.' })]));
  }
}

function promoAvailable(promo) {
  let left = null;
  for (const part of promo.components) {
    const base = state.config.products.find((p) => p.id === part.productId);
    if (!base || base.stock === null || base.stock === undefined) continue;
    const fits = Math.floor(base.stock / part.qty);
    left = left === null ? fits : Math.min(left, fits);
  }
  return left;
}

function renderPromoParts() {
  $('promo-parts').replaceChildren(...promoParts.map((part, index) => el('span', { class: 'choice', style: 'flex:0 0 auto' }, [
    `${part.qty} x ${productName(part.productId)} `,
    el('button', {
      class: 'link-btn',
      title: 'Quitar de la promo',
      onclick: () => { promoParts.splice(index, 1); renderPromoParts(); },
    }, ['Quitar']),
  ])));
  if (!promoParts.length) $('promo-parts').replaceChildren(el('span', { class: 'muted', style: 'font-size:13px', text: 'Elige los productos que incluye la promo.' }));
}

function addPromoPart() {
  const productId = Number($('promo-part').value);
  const qty = Number.parseInt($('promo-part-qty').value, 10) || 1;
  if (!productId || qty <= 0) return;
  const existing = promoParts.find((part) => part.productId === productId);
  if (existing) existing.qty += qty;
  else promoParts.push({ productId, qty });
  $('promo-part-qty').value = '1';
  renderPromoParts();
}

function editPromo(promo) {
  editingPromo = promo;
  $('promo-name').value = promo.name;
  $('promo-price').value = promo.price;
  $('promo-category').value = promo.category || '';
  promoParts = promo.components.map((part) => ({ ...part }));
  $('promo-save').textContent = 'Guardar cambios';
  $('promo-cancel').hidden = false;
  renderPromoParts();
  $('promo-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('promo-name').focus();
}

function resetPromoForm() {
  editingPromo = null;
  promoParts = [];
  $('promo-name').value = '';
  $('promo-price').value = '';
  $('promo-category').value = 'Promos';
  $('promo-save').textContent = 'Crear promo';
  $('promo-cancel').hidden = true;
  renderPromoParts();
}

async function savePromo() {
  const name = $('promo-name').value.trim();
  if (!name) { $('promo-name').focus(); return; }
  if (!promoParts.length) { toast('Agrega al menos un producto a la promo', { type: 'bad' }); return; }
  const body = { name, price: $('promo-price').value, category: $('promo-category').value, components: promoParts };
  try {
    if (editingPromo) await api(`/api/products/${editingPromo.id}`, { method: 'PUT', body: { ...editingPromo, ...body } });
    else await api('/api/products', { method: 'POST', body });
    toast(editingPromo ? 'Promo actualizada' : 'Promo creada', { type: 'ok' });
    resetPromoForm();
    await reload();
  } catch (err) {
    toast('No se pudo guardar la promo', { detail: err.message, type: 'bad' });
  }
}

function stationSelect(product) {
  const select = el('select', {
    style: 'width:100%',
    onchange: (event) => updateProduct(product, { stationId: event.target.value === '' ? null : Number(event.target.value) }),
  }, [
    ...state.config.stations.map((station) => el('option', { value: station.id, text: station.name })),
    el('option', { value: '', text: 'Sin stand' }),
  ]);
  select.value = product.stationId ?? '';
  return select;
}

async function addProduct() {
  const name = $('p-name').value.trim();
  if (!name) { $('p-name').focus(); return; }
  try {
    await api('/api/products', {
      method: 'POST',
      body: {
        name,
        price: $('p-price').value,
        category: $('p-category').value,
        stationId: $('p-station').value === '' ? null : Number($('p-station').value),
        stock: $('p-stock').value.trim(),
      },
    });
    $('p-name').value = '';
    $('p-price').value = '';
    $('p-stock').value = '';
    $('p-name').focus();
    await reload();
    toast('Producto agregado', { type: 'ok' });
  } catch (err) {
    toast('No se pudo guardar', { detail: err.message, type: 'bad' });
  }
}

async function updateProduct(product, patch) {
  try {
    await api(`/api/products/${product.id}`, { method: 'PUT', body: { ...product, ...patch } });
    await reload();
  } catch (err) {
    toast('No se pudo guardar', { detail: err.message, type: 'bad' });
    await reload();
  }
}

async function removeProduct(product) {
  const ok = await confirmDialog('Borrar producto', `Se borrara "${product.name}" del catalogo. Los pedidos antiguos no cambian. Si solo quieres esconderlo, usa el boton Activo/Oculto.`, { danger: true, confirmText: 'Borrar' });
  if (!ok) return;
  try {
    await api(`/api/products/${product.id}`, { method: 'DELETE' });
    await reload();
  } catch (err) {
    toast('No se pudo borrar', { detail: err.message, type: 'bad' });
  }
}

async function addStation() {
  const name = $('s-name').value.trim();
  if (!name) return;
  try {
    await api('/api/stations', { method: 'POST', body: { name } });
    $('s-name').value = '';
    await reload();
    toast('Stand agregado', { type: 'ok' });
  } catch (err) {
    toast('No se pudo guardar', { detail: err.message, type: 'bad' });
  }
}

async function saveStation(station) {
  try {
    await api(`/api/stations/${station.id}`, { method: 'PUT', body: station });
    await reload();
  } catch (err) {
    toast('No se pudo guardar', { detail: err.message, type: 'bad' });
  }
}

async function removeStation(station) {
  const ok = await confirmDialog('Borrar stand', `Se borrara "${station.name}".`, { danger: true, confirmText: 'Borrar' });
  if (!ok) return;
  try {
    await api(`/api/stations/${station.id}`, { method: 'DELETE' });
    await reload();
  } catch (err) {
    toast('No se pudo borrar', { detail: err.message, type: 'bad' });
  }
}

// -------------------------------------------------------------- preferencias

function fillSettings() {
  const business = state.config.business;
  $('b-name').value = business.name || '';
  $('b-subtitle').value = business.subtitle || '';
  $('b-extra').value = business.extraLine || '';
  $('b-footer').value = business.footer || '';

  const printer = settings?.printer || {};
  const tickets = settings?.tickets || state.config.tickets;
  $('pr-mode').value = printer.mode || state.config.printer.mode || 'none';
  $('pr-width').value = String(printer.charsPerLine || state.config.printer.charsPerLine || 32);
  $('pr-host').value = printer.host || '';
  $('pr-port').value = printer.port || 9100;
  $('pr-device').value = printer.device || '';
  $('pr-command').value = printer.command || '';
  $('pr-file').value = printer.file || 'data/spool.bin';
  $('pr-barcode').value = printer.barcode || 'code39';
  $('pr-encoding').value = printer.encoding || 'cp850';
  $('pr-codepage').value = printer.codepage ?? 2;
  $('pr-feed').value = printer.feedLines ?? 3;
  $('pr-cut').checked = printer.cut !== false;
  $('pr-drawer').checked = Boolean(printer.openDrawer);
  $('pr-no-chinese').checked = Boolean(printer.cancelChineseMode);
  $('t-receipt').checked = tickets.printReceipt !== false;
  $('t-stations').checked = tickets.printStationTickets !== false;
  $('t-receipt-copies').value = tickets.receiptCopies ?? 1;
  $('t-station-copies').value = tickets.stationTicketCopies ?? 1;
  $('admin-pin').value = settings?.adminPin || '';
  $('day-start').value = settings?.businessDayStartHour ?? 5;
  $('code-cashier').value = settings?.access?.cashierCode || '';
  $('code-stand').value = settings?.access?.standCode || '';
  togglePrinterRows();
  loadRemote();
}

// ------------------------------------------------------------ acceso remoto

// mismo alfabeto que el servidor: sin O/0 ni I/1/L, que se confunden al dictarlos
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

async function loadRemote() {
  try {
    const remote = await api('/api/remote');
    const { tunnel } = remote;
    let text = remote.url || 'Sin direccion';
    if (tunnel.url) text = `${tunnel.url}  (tunel activo)`;
    else if (tunnel.error) text = `${remote.url || ''}  -  Tunel: ${tunnel.error}`;
    else if (tunnel.active) text = 'Iniciando tunel...';
    else text = `${remote.url}  (solo red local: para internet inicia con start-tunnel.bat)`;
    $('remote-url').textContent = text;
    // el tunel tarda unos segundos en dar su direccion
    if (tunnel.active && !tunnel.url) setTimeout(loadRemote, 3000);
  } catch (err) {
    $('remote-url').textContent = `No se pudo consultar: ${err.message}`;
  }
}

async function saveAccess() {
  await saveSettings({ access: { cashierCode: $('code-cashier').value, standCode: $('code-stand').value } }, 'Codigos guardados');
  settings = (await api('/api/settings')).settings;
  $('code-cashier').value = settings.access?.cashierCode || '';
  $('code-stand').value = settings.access?.standCode || '';
}

async function printAccess(role) {
  try {
    const result = await api('/api/access/print', { method: 'POST', body: { role } });
    $('access-output').style.display = '';
    $('access-output').textContent = result.text;
    if (result.ok) toast('Acceso impreso', { type: 'ok' });
    else toast('No se pudo imprimir', { detail: result.error, type: 'bad' });
  } catch (err) {
    toast('No se pudo imprimir', { detail: err.message, type: 'bad' });
  }
}

function togglePrinterRows() {
  const mode = $('pr-mode').value;
  $('row-network').style.display = mode === 'network' ? '' : 'none';
  $('row-device').style.display = mode === 'device' ? '' : 'none';
  $('row-command').style.display = mode === 'command' ? '' : 'none';
  $('row-file').style.display = mode === 'file' ? '' : 'none';
}

async function saveSettings(patch, message) {
  try {
    await api('/api/settings', { method: 'PUT', body: patch });
    await loadConfig();
    renderTopbar('admin');
    refreshPrinterStatus();
    toast(message, { type: 'ok' });
  } catch (err) {
    toast('No se pudo guardar', { detail: err.message, type: 'bad' });
  }
}

function saveBusiness() {
  return saveSettings({
    business: {
      name: $('b-name').value,
      subtitle: $('b-subtitle').value,
      extraLine: $('b-extra').value,
      footer: $('b-footer').value,
    },
  }, 'Datos del negocio guardados');
}

function savePrinter() {
  const mode = $('pr-mode').value;
  return saveSettings({
    printer: {
      enabled: mode !== 'none',
      mode,
      host: $('pr-host').value.trim(),
      port: Number($('pr-port').value) || 9100,
      device: $('pr-device').value.trim(),
      command: $('pr-command').value.trim(),
      file: $('pr-file').value.trim() || 'data/spool.bin',
      charsPerLine: Number($('pr-width').value) || 32,
      encoding: $('pr-encoding').value,
      codepage: Number($('pr-codepage').value),
      barcode: $('pr-barcode').value,
      feedLines: Number($('pr-feed').value) || 0,
      cut: $('pr-cut').checked,
      openDrawer: $('pr-drawer').checked,
      cancelChineseMode: $('pr-no-chinese').checked,
    },
    tickets: {
      printReceipt: $('t-receipt').checked,
      printStationTickets: $('t-stations').checked,
      receiptCopies: Number($('t-receipt-copies').value) || 1,
      stationTicketCopies: Number($('t-station-copies').value) || 1,
    },
  }, 'Impresora guardada');
}

async function saveSecurity() {
  const pin = $('admin-pin').value.trim();
  await saveSettings({ adminPin: pin, businessDayStartHour: Number($('day-start').value) || 0 }, 'Ajustes guardados');
  if (pin && pin !== '****') localStorage.setItem('adminPin', pin);
  if (!pin) localStorage.removeItem('adminPin');
}

async function testPrinter() {
  try {
    const result = await api('/api/printer/test', { method: 'POST' });
    $('test-output').style.display = '';
    $('test-output').textContent = result.text;
    if (result.ok) toast('Ticket de prueba enviado', { type: 'ok' });
    else toast('No se pudo imprimir', { detail: result.error, type: 'bad' });
  } catch (err) {
    toast('No se pudo imprimir', { detail: err.message, type: 'bad' });
  }
}

async function checkPrinter() {
  const { status } = await api('/api/printer/status');
  toast(status.reachable ? 'Impresora conectada' : 'Sin conexion con la impresora', {
    detail: `${status.description} - ${status.message}`,
    type: status.reachable ? 'ok' : 'bad',
  });
  refreshPrinterStatus();
}
