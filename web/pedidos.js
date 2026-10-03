// Listado de pedidos: reimprimir, anular, marcar retiros entregados y ver el ticket.
import { api, loadConfig, requireRole, state, money, el, toast, openModal, confirmDialog, renderTopbar, time, humanDate, printTextInBrowser } from './common.js';

const $ = (id) => document.getElementById(id);
let orders = [];
let timer = null;

init().catch((err) => toast('Error al cargar', { detail: err.message, type: 'bad' }));

async function init() {
  await loadConfig();
  if (!requireRole('cashier')) return;
  renderTopbar('pedidos');
  const { days } = await api('/api/days');
  const today = state.config.day;
  const options = days.includes(today) ? days : [today, ...days];
  $('day').replaceChildren(...options.map((day) => el('option', { value: day, text: humanDate(day) + (day === today ? ' (hoy)' : '') })));
  $('day').value = today;

  $('day').addEventListener('change', load);
  $('reload').addEventListener('click', load);
  $('filter').addEventListener('input', render);
  $('auto').addEventListener('change', (event) => {
    clearInterval(timer);
    if (event.target.checked) timer = setInterval(load, 10000);
  });
  await load();
  if (location.hash) highlight(location.hash.slice(1));
}

async function load() {
  const { orders: list } = await api(`/api/orders?day=${encodeURIComponent($('day').value)}`);
  orders = list;
  render();
}

/** Stands del pedido: una promo se reparte en los stands de lo que incluye. */
function stationsOf(order) {
  const groups = new Map();
  for (const item of order.items) {
    const parts = item.components?.length ? item.components : [item];
    for (const part of parts) {
      const key = String(part.stationId ?? 'null');
      if (!groups.has(key)) groups.set(key, { key, stationId: part.stationId ?? null, name: part.stationName || 'RETIRO' });
    }
  }
  return [...groups.values()];
}

function render() {
  const term = $('filter').value.trim().toLowerCase();
  const filtered = orders.filter((order) => {
    if (!term) return true;
    const haystack = [order.code, order.customer, order.cashier, ...order.items.map((item) => item.name)].join(' ').toLowerCase();
    return haystack.includes(term);
  });

  const valid = orders.filter((order) => order.status !== 'void');
  $('summary').replaceChildren(
    stat('Pedidos', String(valid.length)),
    stat('Vendido', money(valid.reduce((sum, order) => sum + order.total, 0))),
    stat('Articulos', String(valid.reduce((sum, order) => sum + order.items.reduce((n, item) => n + item.qty, 0), 0))),
    stat('Anulados', String(orders.length - valid.length)),
  );

  $('rows').replaceChildren(...filtered.map(renderRow));
  if (!filtered.length) {
    $('rows').replaceChildren(el('tr', {}, [el('td', { colspan: 8, class: 'muted', text: 'Sin pedidos todavia.' })]));
  }
}

function stat(label, value) {
  return el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value })]);
}

function renderRow(order) {
  const groups = stationsOf(order);
  const detail = order.items.map((item) => `${item.qty}x ${item.name}`).join(', ');
  return el('tr', { class: order.status === 'void' ? 'void' : '', id: `order-${order.id}` }, [
    el('td', {}, [el('strong', { text: order.code })]),
    el('td', { text: time(order.createdAt) }),
    el('td', {}, [
      el('div', { text: detail }),
      order.customer ? el('div', { class: 'muted', text: `Cliente: ${order.customer}` }) : null,
      order.note ? el('div', { class: 'muted', text: `Nota: ${order.note}` }) : null,
      order.lastPrintError ? el('div', {}, [el('span', { class: 'tag bad', text: 'Fallo la impresion' })]) : null,
    ]),
    el('td', {}, groups.map((group) => {
      const delivered = Boolean(order.deliveries?.[group.key]);
      return el('button', {
        class: `tag ${delivered ? 'ok' : 'warn'}`,
        style: 'cursor:pointer;border:none;margin:2px 2px 2px 0',
        title: delivered ? 'Marcar como pendiente' : 'Marcar como entregado',
        onclick: () => toggleDelivery(order, group, !delivered),
      }, [`${group.name}${delivered ? ' OK' : ''}`]);
    })),
    el('td', { class: 'num', text: money(order.total) }),
    el('td', { text: paymentLabel(order.paymentMethod) }),
    el('td', { text: order.cashier }),
    el('td', {}, [el('div', { class: 'row-actions' }, [
      el('button', { class: 'btn ghost small', onclick: () => preview(order) }, ['Ver']),
      el('button', { class: 'btn small', onclick: () => reprint(order) }, ['Reimprimir']),
      order.status !== 'void'
        ? el('button', { class: 'btn danger small', onclick: () => voidOrder(order) }, ['Anular'])
        : el('span', { class: 'tag bad', text: 'Anulado' }),
    ])]),
  ]);
}

function paymentLabel(key) {
  return state.config.paymentMethods.find((method) => method.key === key)?.label || key;
}

async function toggleDelivery(order, group, delivered) {
  try {
    await api(`/api/orders/${order.id}/deliver`, { method: 'POST', body: { stationId: group.stationId, delivered } });
    await load();
  } catch (err) {
    toast('No se pudo actualizar', { detail: err.message, type: 'bad' });
  }
}

async function reprint(order) {
  const groups = stationsOf(order);
  const { close } = openModal([
    el('h2', { text: `Reimprimir pedido N\u00b0 ${order.code}` }),
    el('p', { class: 'sub', text: 'Elige que documento volver a imprimir.' }),
    el('div', { class: 'modal-actions', style: 'flex-direction:column' }, [
      el('button', { class: 'btn ok block', onclick: () => run('all') }, ['Todo (venta + retiros)']),
      el('button', { class: 'btn block', onclick: () => run('receipt') }, ['Solo el ticket de venta']),
      ...groups.map((group) => el('button', {
        class: 'btn ghost block',
        onclick: () => run(`station:${group.key}`),
      }, [`Ticket de retiro: ${group.name}`])),
      el('button', { class: 'btn ghost block', onclick: () => close() }, ['Cancelar']),
    ]),
  ]);

  async function run(what) {
    close();
    try {
      const result = await api(`/api/orders/${order.id}/print`, { method: 'POST', body: { what } });
      if (result.print.ok) toast('Enviado a la impresora', { type: 'ok' });
      else toast('No se pudo imprimir', { detail: result.print.error, type: 'bad' });
      await load();
    } catch (err) {
      toast('No se pudo imprimir', { detail: err.message, type: 'bad' });
    }
  }
}

async function preview(order) {
  const { documents } = await api(`/api/orders/${order.id}/preview`);
  openModal([
    el('h2', { text: `Pedido N\u00b0 ${order.code}` }),
    el('p', { class: 'sub', text: `${humanDate(order.day)} ${time(order.createdAt)} - ${order.cashier}` }),
    ...documents.flatMap((doc) => [
      el('h3', { text: doc.title, style: 'font-size:14px;margin:14px 0 6px' }),
      el('pre', { class: 'ticket-preview', text: doc.text }),
      el('button', { class: 'btn ghost small', onclick: () => printTextInBrowser(doc.text, doc.title) }, ['Imprimir desde el navegador']),
    ]),
  ]);
}

async function voidOrder(order) {
  const ok = await confirmDialog('Anular pedido', `El pedido N\u00b0 ${order.code} por ${money(order.total)} dejara de sumar en el cierre. Esta accion no se puede deshacer.`, { danger: true, confirmText: 'Anular' });
  if (!ok) return;
  try {
    await api(`/api/orders/${order.id}/void`, { method: 'POST', body: { reason: 'Anulado en caja' } });
    toast('Pedido anulado', { type: 'ok' });
    await load();
  } catch (err) {
    toast('No se pudo anular', { detail: err.message, type: 'bad' });
  }
}

function highlight(id) {
  const row = document.getElementById(`order-${id}`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.style.background = '#fff7d6';
}
