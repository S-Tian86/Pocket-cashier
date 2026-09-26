// Ajustes: catalogo de productos, stands, datos del negocio e impresora.
import { api, loadConfig, state, money, el, toast, confirmDialog, renderTopbar, refreshPrinterStatus } from './common.js';

const $ = (id) => document.getElementById(id);
let settings = null;

init().catch((err) => toast('Error al cargar', { detail: err.message, type: 'bad' }));

async function init() {
  await loadConfig();
  renderTopbar('admin');
  await ensurePin();
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
      return;
    } catch (err) {
      if (err.status !== 401) throw err;
      const pin = window.prompt('PIN de administrador:');
      if (pin === null) { location.href = '/'; return; }
      localStorage.setItem('adminPin', pin);
    }
  }
  toast('PIN incorrecto', { type: 'bad' });
  location.href = '/';
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
}

// ------------------------------------------------------------------ catalogo

async function reload() {
  await loadConfig();
  renderCatalog();
}

function renderCatalog() {
  const stations = state.config.stations;
  const products = [...state.config.products].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));

  $('p-station').replaceChildren(
    ...stations.map((station) => el('option', { value: station.id, text: station.name })),
    el('option', { value: '', text: 'Sin stand' }),
  );
  $('categorias').replaceChildren(...[...new Set(products.map((p) => p.category).filter(Boolean))].map((c) => el('option', { value: c })));

  $('products').replaceChildren(...products.map((product) => el('tr', { class: product.active === false ? 'void' : '' }, [
    el('td', {}, [editable(product, 'name', 'text')]),
    el('td', { class: 'num' }, [editable(product, 'price', 'number')]),
    el('td', {}, [editable(product, 'category', 'text')]),
    el('td', {}, [stationSelect(product)]),
    el('td', {}, [el('button', {
      class: `tag ${product.active === false ? 'bad' : 'ok'}`,
      style: 'cursor:pointer;border:none',
      onclick: () => updateProduct(product, { active: product.active === false }),
    }, [product.active === false ? 'Oculto' : 'Activo'])]),
    el('td', {}, [el('button', { class: 'btn danger small', onclick: () => removeProduct(product) }, ['Borrar'])]),
  ])));

  $('stations').replaceChildren(...stations.map((station) => {
    const count = products.filter((product) => product.stationId === station.id).length;
    return el('tr', {}, [
      el('td', {}, [el('input', {
        value: station.name,
        style: 'width:100%',
        onchange: (event) => saveStation({ ...station, name: event.target.value }),
      })]),
      el('td', { text: `${count} productos` }),
      el('td', {}, [el('button', {
        class: `tag ${station.active === false ? 'bad' : 'ok'}`,
        style: 'cursor:pointer;border:none',
        onclick: () => saveStation({ ...station, active: station.active === false }),
      }, [station.active === false ? 'Oculto' : 'Activo'])]),
      el('td', {}, [el('button', { class: 'btn danger small', onclick: () => removeStation(station) }, ['Borrar'])]),
    ]);
  }));
}

function editable(product, field, type) {
  return el('input', {
    value: product[field] ?? '',
    inputmode: type === 'number' ? 'numeric' : undefined,
    style: `width:100%${type === 'number' ? ';text-align:right' : ''}`,
    onchange: (event) => updateProduct(product, { [field]: event.target.value }),
  });
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
      },
    });
    $('p-name').value = '';
    $('p-price').value = '';
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
  await api(`/api/products/${product.id}`, { method: 'DELETE' });
  await reload();
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
  togglePrinterRows();
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
