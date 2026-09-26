// Resumen del dia: totales, ranking de productos, ventas por stand, caja y hora.
import { api, loadConfig, requireRole, state, money, el, toast, renderTopbar, humanDate, time } from './common.js';

const $ = (id) => document.getElementById(id);
let report = null;

init().catch((err) => toast('Error al cargar', { detail: err.message, type: 'bad' }));

async function init() {
  await loadConfig();
  if (!requireRole('cashier')) return;
  renderTopbar('cierre');
  const { days } = await api('/api/days');
  const today = state.config.day;
  const options = days.includes(today) ? days : [today, ...days];
  $('day').replaceChildren(...options.map((day) => el('option', { value: day, text: humanDate(day) + (day === today ? ' (hoy)' : '') })));
  $('day').value = today;
  $('day').addEventListener('change', load);
  $('print').addEventListener('click', printReport);
  $('browser-print').addEventListener('click', () => window.print());
  $('csv').addEventListener('click', downloadCsv);
  await load();
}

async function load() {
  const result = await api(`/api/report?day=${encodeURIComponent($('day').value)}`);
  report = result.report;
  render();
}

function stat(label, value) {
  return el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value })]);
}

function table(headers, rows) {
  return el('div', { style: 'overflow-x:auto' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, headers.map((head, index) => el('th', { class: index ? 'num' : '', text: head })))]),
      el('tbody', {}, rows.map((row) => el('tr', {}, row.map((cell, index) => el('td', { class: index ? 'num' : '', text: cell }))))),
    ]),
  ]);
}

function render() {
  const content = $('content');
  if (!report.ordersCount && !report.voidedCount) {
    content.replaceChildren(el('div', { class: 'card' }, [el('p', { class: 'muted', text: 'No hay ventas registradas este dia.' })]));
    return;
  }

  content.replaceChildren(
    el('div', { class: 'stats' }, [
      stat('Total vendido', money(report.total)),
      stat('Pedidos', String(report.ordersCount)),
      stat('Articulos', String(report.itemsCount)),
      stat('Ticket promedio', money(report.averageTicket)),
      stat('Efectivo', money(report.cashTotal)),
      report.voidedCount ? stat('Anulados', `${report.voidedCount} (${money(report.voidedTotal)})`) : null,
    ].filter(Boolean)),

    el('div', { class: 'card' }, [
      el('h2', { text: `Resumen ${humanDate(report.day)}` }),
      el('p', { class: 'muted', text: report.firstOrderAt ? `Primer pedido ${time(report.firstOrderAt)} - ultimo ${time(report.lastOrderAt)}` : '' }),
      table(['Medio de pago', 'Pedidos', 'Total'], report.byPayment.map((row) => [labelOf(row.key), String(row.orders), money(row.total)])),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Ventas por producto' }),
      table(['Producto', 'Cantidad', 'Precio', 'Total'], report.byProduct.map((row) => [row.name, String(row.qty), money(row.price), money(row.total)])),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Por stand de retiro' }),
      table(['Stand', 'Articulos', 'Total'], report.byStation.map((row) => [row.name, String(row.qty), money(row.total)])),
    ]),

    el('div', { class: 'card' }, [
      el('h2', { text: 'Por caja' }),
      table(['Caja', 'Pedidos', 'Total'], report.byCashier.map((row) => [row.name, String(row.orders), money(row.total)])),
    ]),

    report.hourly.length ? el('div', { class: 'card' }, [
      el('h2', { text: 'Por hora' }),
      table(['Hora', 'Pedidos', 'Total'], report.hourly.map((row) => [`${row.hour}:00`, String(row.orders), money(row.total)])),
    ]) : null,
  );
}

function labelOf(key) {
  return state.config.paymentMethods.find((method) => method.key === key)?.label || key;
}

async function printReport() {
  try {
    const result = await api('/api/report/print', { method: 'POST', body: { day: $('day').value } });
    if (result.ok) toast('Cierre enviado a la impresora', { type: 'ok' });
    else toast('No se pudo imprimir', { detail: result.error, type: 'bad' });
  } catch (err) {
    toast('No se pudo imprimir', { detail: err.message, type: 'bad' });
  }
}

function downloadCsv() {
  const rows = [
    ['Cierre', humanDate(report.day)],
    [],
    ['Producto', 'Cantidad', 'Precio', 'Total'],
    ...report.byProduct.map((row) => [row.name, row.qty, row.price, row.total]),
    [],
    ['Medio de pago', 'Pedidos', 'Total'],
    ...report.byPayment.map((row) => [labelOf(row.key), row.orders, row.total]),
    [],
    ['Stand', 'Articulos', 'Total'],
    ...report.byStation.map((row) => [row.name, row.qty, row.total]),
    [],
    ['TOTAL', '', '', report.total],
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(';')).join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = el('a', { href: URL.createObjectURL(blob), download: `cierre-${report.day}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
}
